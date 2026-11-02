import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { join } from "node:path";

type Message = Record<string, unknown>;

export interface CoreRpcOptions {
  address: string;
  protoDir: string;
  token?: string;
  deadlineMs?: number;
}

export interface EventSubscription { cancel(): void }

interface Endpoint {
  client: grpc.Client;
  definition: grpc.ServiceDefinition;
}

function object(value: unknown): value is Message {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function constructorAt(root: grpc.GrpcObject, namespace: "v2" | "vnext", name: "EngineExecution" | "EngineEvents"): grpc.ServiceClientConstructor {
  let current: unknown = root;
  for (const component of ["execution_engine", namespace, name]) {
    if (!object(current)) throw new Error(`Missing proto service execution_engine.${namespace}.${name}`);
    current = current[component];
  }
  if (typeof current !== "function" || !("service" in current))
    throw new Error(`Invalid proto service execution_engine.${namespace}.${name}`);
  // grpc-js builds these constructors dynamically from the checked-in proto.
  return current as unknown as grpc.ServiceClientConstructor;
}

function methodAt(endpoint: Endpoint, method: string, streaming: boolean): grpc.MethodDefinition<Message, Message> {
  const definition = endpoint.definition[method];
  if (!definition || definition.requestStream || definition.responseStream !== streaming)
    throw new Error(`Unknown or incompatible ${streaming ? "streaming" : "unary"} RPC: ${method}`);
  // The library's generic ServiceDefinition has untyped messages. This is the
  // sole wire-message cast; received values are checked again at the boundary.
  return definition as grpc.MethodDefinition<Message, Message>;
}

/** One RPC attempt per call. Reconnect/reconciliation decisions belong to the caller. */
export class CoreRpc {
  private readonly executions: Record<"v2" | "next", Endpoint>;
  private readonly events: Endpoint;
  private readonly token: string | undefined;
  private readonly deadlineMs: number;
  private readonly subscriptions = new Set<EventSubscription>();
  private closed = false;

  constructor(options: CoreRpcOptions) {
    this.deadlineMs = options.deadlineMs ?? 10_000;
    if (!Number.isSafeInteger(this.deadlineMs) || this.deadlineMs <= 0)
      throw new Error("deadlineMs must be a positive safe integer");
    this.token = options.token;
    const definition = protoLoader.loadSync([
      join(options.protoDir, "execution_engine_v2.proto"),
      join(options.protoDir, "execution_engine_vnext.proto"),
    ], {
      keepCase: true, longs: String, enums: String,
      // Prost omits non-optional false/0 fields. Restore their proto3 defaults;
      // genuine proto3 optional scalars remain absent through their oneofs.
      defaults: true, arrays: true, oneofs: true,
      includeDirs: [options.protoDir],
    });
    const loaded = grpc.loadPackageDefinition(definition);
    const v2 = constructorAt(loaded, "v2", "EngineExecution");
    const next = constructorAt(loaded, "vnext", "EngineExecution");
    const events = constructorAt(loaded, "vnext", "EngineEvents");
    const connect = (service: grpc.ServiceClientConstructor): Endpoint => ({
      client: new service(options.address, grpc.credentials.createInsecure(), { "grpc.enable_retries": 0 }),
      definition: service.service,
    });
    this.executions = { v2: connect(v2), next: connect(next) };
    this.events = connect(events);
  }

  private metadata(): grpc.Metadata {
    const metadata = new grpc.Metadata();
    if (this.token) metadata.set("authorization", `Bearer ${this.token}`);
    return metadata;
  }

  async unary(service: "v2" | "next", method: string, request: Message): Promise<Message> {
    if (this.closed) throw new Error("CoreRpc is closed");
    const endpoint = this.executions[service];
    const definition = methodAt(endpoint, method, false);
    return new Promise((resolve, reject) => {
      endpoint.client.makeUnaryRequest(
        definition.path, definition.requestSerialize, definition.responseDeserialize,
        request, this.metadata(), { deadline: Date.now() + this.deadlineMs },
        (error, response) => {
          if (error) reject(error);
          else if (!object(response)) reject(new Error(`Invalid response object for ${method}`));
          else resolve(response);
        },
      );
    });
  }

  streamEvents(request: Message, onData: (data: Message) => void, onError: (error: Error) => void): EventSubscription {
    if (this.closed) throw new Error("CoreRpc is closed");
    const definition = methodAt(this.events, "StreamEvents", true);
    const stream = this.events.client.makeServerStreamRequest(
      definition.path, definition.requestSerialize, definition.responseDeserialize,
      request, this.metadata(),
    );
    let terminal = false;
    const subscription: EventSubscription = {
      cancel: () => {
        if (terminal) return;
        terminal = true;
        this.subscriptions.delete(subscription);
        stream.cancel();
      },
    };
    const fail = (error: Error) => {
      if (terminal) return;
      terminal = true;
      this.subscriptions.delete(subscription);
      onError(error);
    };
    this.subscriptions.add(subscription);
    stream.on("data", (data: unknown) => {
      if (terminal) return;
      try {
        if (!object(data)) throw new Error("Invalid StreamEvents response object");
        onData(data);
      } catch (error) {
        fail(error instanceof Error ? error : new Error("StreamEvents consumer failed"));
        stream.cancel();
      }
    });
    stream.on("error", (error: Error) => fail(error));
    // The API has no separate onEnd callback. A remote normal end is surfaced
    // once so the caller can decide whether/when to reconnect with its cursor.
    stream.on("end", () => fail(new Error("StreamEvents ended by the server")));
    return subscription;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const subscription of this.subscriptions) subscription.cancel();
    for (const endpoint of Object.values(this.executions)) endpoint.client.close();
    this.events.client.close();
  }
}
