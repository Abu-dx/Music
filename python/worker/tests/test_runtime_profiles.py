import importlib.util
import pathlib
import sys
import unittest


def _load_runtime_profiles_module():
    module_path = pathlib.Path(__file__).resolve().parents[1] / "runtime_profiles.py"
    spec = importlib.util.spec_from_file_location("runtime_profiles", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Failed to create module spec for runtime_profiles.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


runtime_profiles = _load_runtime_profiles_module()
RuntimeProfile = runtime_profiles.RuntimeProfile
RuntimeProfileRegistry = runtime_profiles.RuntimeProfileRegistry


class RuntimeProfileRegistryTests(unittest.TestCase):
    def test_subprocess_profile_requires_environment_root(self):
        with self.assertRaises(ValueError):
            RuntimeProfileRegistry([
                RuntimeProfile(
                    id="demucs_a",
                    model_id="demucs",
                    executable="python",
                    environment_root="",
                    health_check=["python", "-c", "print('ok')"],
                    isolation_mode="subprocess",
                ),
            ])

    def test_subprocess_profiles_must_not_share_environment_root(self):
        with self.assertRaises(ValueError):
            RuntimeProfileRegistry([
                RuntimeProfile(
                    id="demucs_a",
                    model_id="demucs",
                    executable="python",
                    environment_root="D:/venv/shared",
                    health_check=["python", "-c", "print('ok')"],
                    isolation_mode="subprocess",
                ),
                RuntimeProfile(
                    id="demucs_b",
                    model_id="demucs",
                    executable="python",
                    environment_root="D:/venv/shared",
                    health_check=["python", "-c", "print('ok')"],
                    isolation_mode="subprocess",
                ),
            ])

    def test_fallback_profile_must_exist(self):
        with self.assertRaises(ValueError):
            RuntimeProfileRegistry([
                RuntimeProfile(
                    id="demucs_a",
                    model_id="demucs",
                    executable="python",
                    environment_root="D:/venv/a",
                    health_check=["python", "-c", "print('ok')"],
                    isolation_mode="subprocess",
                    fallback_profile_id="demucs_missing",
                ),
            ])

    def test_subprocess_profile_requires_health_check(self):
        with self.assertRaises(ValueError):
            RuntimeProfileRegistry([
                RuntimeProfile(
                    id="demucs_a",
                    model_id="demucs",
                    executable="python",
                    environment_root="D:/venv/a",
                    health_check=None,
                    isolation_mode="subprocess",
                ),
            ])

    def test_command_gate_blocks_unadmitted_model(self):
        registry = RuntimeProfileRegistry([
            RuntimeProfile(
                id="analysis_default",
                model_id="analysis",
                executable="python",
                environment_root="inprocess://analysis_default",
                isolation_mode="inprocess",
                allow_fallback=False,
            ),
        ])
        profile = registry.get("analysis_default")
        self.assertIsNotNone(profile)
        with self.assertRaises(RuntimeError):
            registry.validate_for_command(profile, "start_separation", {"demucs"})


if __name__ == "__main__":
    unittest.main()
