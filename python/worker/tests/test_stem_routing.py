import importlib.util
import pathlib
import unittest


def _load_stem_routing_module():
    module_path = pathlib.Path(__file__).resolve().parents[1] / "stem_routing.py"
    spec = importlib.util.spec_from_file_location("stem_routing", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Failed to create module spec for stem_routing.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


stem_routing = _load_stem_routing_module()


class StemRoutingPlanTests(unittest.TestCase):
    def test_default_plan_reserves_all_common_stems(self):
        plan = stem_routing.build_stem_routing_plan(
            request_id="req-default",
            base_runner="demucs",
            base_model="htdemucs",
            base_supported_stems=["vocal", "drums", "bass", "other"],
            requested_config_json="",
        )

        self.assertEqual("stem-routing-v1", plan["version"])
        self.assertEqual("base_only", plan["routingMode"])
        self.assertEqual(6, len(plan["assignments"]))

        mapping = {item["stem"]: item for item in plan["assignments"]}
        self.assertTrue(mapping["vocals"]["emitsFromBaseModel"])
        self.assertFalse(mapping["piano"]["emitsFromBaseModel"])
        self.assertEqual("base_model_missing_stem", mapping["piano"]["reason"])

    def test_unknown_runner_override_keeps_base_fallback(self):
        plan = stem_routing.build_stem_routing_plan(
            request_id="req-unknown-runner",
            base_runner="demucs",
            base_model="htdemucs_6s",
            base_supported_stems=["vocal", "drums", "bass", "guitar", "keyboard", "other"],
            requested_config_json='{"piano":{"runner":"runner_mdx_piano","model":"uvr"}}',
        )

        mapping = {item["stem"]: item for item in plan["assignments"]}
        piano = mapping["piano"]
        self.assertEqual("runner_mdx_piano", piano["requestedRunner"])
        self.assertEqual("demucs", piano["effectiveRunner"])
        self.assertEqual("unknown_runner_fallback_base", piano["reason"])
        self.assertGreaterEqual(len(plan["warnings"]), 1)

    def test_model_override_is_deferred_in_base_only_mode(self):
        plan = stem_routing.build_stem_routing_plan(
            request_id="req-model-override",
            base_runner="demucs",
            base_model="htdemucs",
            base_supported_stems=["vocal", "drums", "bass", "other"],
            requested_config_json='{"other":{"model":"htdemucs_6s"}}',
        )

        mapping = {item["stem"]: item for item in plan["assignments"]}
        other = mapping["other"]
        self.assertEqual("htdemucs_6s", other["requestedModel"])
        self.assertEqual("htdemucs", other["effectiveModel"])
        self.assertEqual("deferred_model_override_base_only", other["reason"])

    def test_invalid_json_is_tolerated(self):
        plan = stem_routing.build_stem_routing_plan(
            request_id="req-invalid-json",
            base_runner="demucs",
            base_model="htdemucs",
            base_supported_stems=["vocal", "drums", "bass", "other"],
            requested_config_json="{invalid}",
        )

        self.assertEqual(6, len(plan["assignments"]))
        self.assertGreaterEqual(len(plan["warnings"]), 1)


if __name__ == "__main__":
    unittest.main()
