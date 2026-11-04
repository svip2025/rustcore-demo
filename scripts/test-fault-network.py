import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("f3", Path(__file__).with_name("fault-network.py"))
f3 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f3)


class Firewall:
    def __init__(self, fail_timer=False, fail_rule=False):
        self.calls, self.chains, self.jumps = [], set(), set()
        self.fail_timer, self.fail_rule = fail_timer, fail_rule

    def __call__(self, args):
        self.calls.append(args)
        if "systemd-run" in args[0]:
            if self.fail_timer:
                raise subprocess.CalledProcessError(1, "timer")
            return ""
        tool, op = args[0], args[3]
        if op == "-N": self.chains.add((tool, args[4]))
        if op == "-A" and self.fail_rule:
            raise subprocess.CalledProcessError(1, "rule")
        if op == "-I": self.jumps.add((tool, args[-1]))
        if op == "-D": self.jumps.discard((tool, args[-1]))
        if op == "-X": self.chains.discard((tool, args[4]))
        if op == "-S":
            return "\n".join([f"-N {n}" for t, n in self.chains if t == tool] +
                             [f"-A OUTPUT -j {n}" for t, n in self.jumps if t == tool])
        return ""


class F3Tests(unittest.TestCase):
    def test_timer_precedes_all_mutation_and_scope_preserves_ssh(self):
        with tempfile.TemporaryDirectory() as d:
            state = f3.plan(["1.1.1.1", "2606:4700:4700::1111"], 300, ["8.8.8.8"])
            command = Firewall()
            f3.inject(state, Path(d)/"state.json", command)
            self.assertIn("systemd-run", command.calls[0][0])
            for args in command.calls[1:]:
                if "-A" in args:
                    self.assertEqual(args[-6:], ["-p", "tcp", "--dport", "443", "-j", "DROP"])
            f3.cleanup(state, command)
            self.assertFalse(command.chains)
            self.assertFalse(command.jumps)
            f3.cleanup(state, command)  # idempotent and verified

    def test_timer_failure_has_no_firewall_side_effect(self):
        with tempfile.TemporaryDirectory() as d:
            command = Firewall(fail_timer=True)
            with self.assertRaises(subprocess.CalledProcessError):
                f3.inject(f3.plan(["1.1.1.1"], 60), Path(d)/"state.json", command)
            self.assertEqual(len(command.calls), 1)
            self.assertFalse(command.chains)

    def test_partial_install_rolls_back_both_families(self):
        with tempfile.TemporaryDirectory() as d:
            command = Firewall(fail_rule=True)
            with self.assertRaises(subprocess.CalledProcessError):
                f3.inject(f3.plan(["1.1.1.1"], 60), Path(d)/"state.json", command)
            self.assertFalse(command.chains)

    def test_private_ssh_bad_dns_and_injected_chain_are_refused(self):
        for addresses in (["127.0.0.1"], ["10.0.0.1"], ["1.1.1.1;id"], []):
            with self.assertRaises(ValueError): f3.plan(addresses, 60)
        with self.assertRaises(ValueError): f3.plan(["1.1.1.1"], 60, ["1.1.1.1"])
        with self.assertRaises(ValueError): f3.plan(["1.1.1.1"], 120)
        state = f3.plan(["1.1.1.1"], 60)
        state["chain"] = "OUTPUT"
        with self.assertRaises(ValueError): f3.cleanup(state, Firewall())


if __name__ == "__main__": unittest.main()
