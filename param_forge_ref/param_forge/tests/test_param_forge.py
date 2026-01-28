import csv
import importlib.util
import json
import pathlib
import tempfile
import unittest
import sys

try:
    from PIL import Image  # type: ignore
except Exception:  # pragma: no cover
    Image = None

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location("param_forge", ROOT / "scripts" / "param_forge.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load param_forge module for tests")
param_forge = importlib.util.module_from_spec(SPEC)
sys.modules["param_forge"] = param_forge
SPEC.loader.exec_module(param_forge)
from forge_image_api.core.contracts import ImageRequest
from forge_image_api.core.solver import resolve_request


class TestWrapText(unittest.TestCase):
    def test_wrap_text_respects_width(self) -> None:
        lines = param_forge._wrap_text("hello world", 5)
        self.assertEqual(lines, ["hello", "world"])

    def test_wrap_text_long_word(self) -> None:
        lines = param_forge._wrap_text("abcdefgh", 3)
        self.assertEqual(lines, ["abc", "def", "gh"])


class TestCostFormatting(unittest.TestCase):
    def test_format_cost_value(self) -> None:
        self.assertEqual(param_forge._format_cost_value(0.002), "$2/1K")
        self.assertEqual(param_forge._format_cost_value(None), "N/A")


class TestRetrievalScore(unittest.TestCase):
    def test_compute_retrieval_score_full(self) -> None:
        axes = {key: 100 for key in param_forge._RETRIEVAL_AXIS_KEYS}
        self.assertEqual(param_forge._compute_retrieval_score(axes), 100)

    def test_compute_retrieval_score_partial(self) -> None:
        axes = {"text_legibility": 80}
        self.assertEqual(param_forge._compute_retrieval_score(axes), 80)

    def test_compact_retrieval_packet(self) -> None:
        packet = {
            "alt_text_120": "alt",
            "caption_280": "cap",
            "entities": ["e1"],
            "claims": [{"text": "c1", "confidence": 0.5}],
            "questions_answered": ["q1"],
            "flags": ["f1"],
            "extra": "drop",
        }
        compact = param_forge._compact_retrieval_packet(packet)
        self.assertIn("alt_text_120", compact)
        self.assertIn("caption_280", compact)
        self.assertIn("entities", compact)
        self.assertIn("claims", compact)
        self.assertIn("questions_answered", compact)
        self.assertIn("flags", compact)
        self.assertNotIn("extra", compact)


class TestImageQualityMetrics(unittest.TestCase):
    def test_quality_gates(self) -> None:
        gates = param_forge._image_quality_gates(
            {
                "brightness_luma_mean": 30,
                "contrast_luma_std": 10,
                "sharpness_edge_mean": 2,
            }
        )
        self.assertIn("too_dark", gates)
        self.assertIn("low_contrast", gates)
        self.assertIn("low_sharpness", gates)

    @unittest.skipIf(Image is None, "Pillow not available")
    def test_compute_image_quality_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = pathlib.Path(tmpdir) / "sample.png"
            Image.new("RGB", (32, 32), (255, 255, 255)).save(path)
            metrics = param_forge._compute_image_quality_metrics(path)
            self.assertIn("brightness_luma_mean", metrics)
            self.assertIn("contrast_luma_std", metrics)
            self.assertIn("sharpness_edge_mean", metrics)
            self.assertIn("colorfulness", metrics)
            self.assertIn("sampled_width", metrics)
            self.assertIn("sampled_height", metrics)


class TestDiffCallSettings(unittest.TestCase):
    def test_output_format_default_annotation(self) -> None:
        prev = {
            "provider": "openai",
            "model": "gpt-image-1.5",
            "size": "1024x1024",
            "n": 1,
            "output_format": None,
        }
        curr = {
            "provider": "openai",
            "model": "gpt-image-1.5",
            "size": "1024x1024",
            "n": 1,
            "output_format": "png",
        }
        diffs = param_forge._diff_call_settings(prev, curr)
        self.assertTrue(
            any(
                diff.startswith("output_format: null (default: png)")
                and diff.endswith("-> png")
                for diff in diffs
            )
        )

    def test_provider_option_default_annotation(self) -> None:
        prev = {
            "provider": "gemini",
            "model": "gemini-2.5-flash-image",
            "size": "1024x1024",
            "n": 1,
            "provider_options": {},
        }
        curr = {
            "provider": "gemini",
            "model": "gemini-2.5-flash-image",
            "size": "1024x1024",
            "n": 1,
            "provider_options": {"image_size": "2K"},
        }
        diffs = param_forge._diff_call_settings(prev, curr)
        self.assertTrue(
            any(
                diff.startswith("provider_options.image_size: null (default: 1K)")
                and diff.endswith("-> 2K")
                for diff in diffs
            )
        )


class TestPromptParsing(unittest.TestCase):
    def test_load_prompts_txt(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = pathlib.Path(tmpdir) / "prompts.txt"
            path.write_text(
                "\n".join(
                    [
                        "# comment",
                        " First prompt ",
                        "",
                        "Second prompt",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            prompts = param_forge._load_prompts_file(path)
            self.assertEqual(len(prompts), 2)
            self.assertEqual(prompts[0]["id"], "p-0001")
            self.assertEqual(prompts[0]["prompt"], "First prompt")
            self.assertEqual(prompts[1]["id"], "p-0002")
            self.assertEqual(prompts[1]["prompt"], "Second prompt")

    def test_load_prompts_csv_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = pathlib.Path(tmpdir) / "prompts.csv"
            metadata = json.dumps({"tone": "warm"})
            with path.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=["id", "prompt", "metadata", "extra"])
                writer.writeheader()
                writer.writerow({"id": "p-foo", "prompt": "Hello", "metadata": metadata, "extra": "x"})
                writer.writerow({"id": "", "prompt": "World", "metadata": "", "extra": "y"})
            prompts = param_forge._load_prompts_file(path)
            self.assertEqual(len(prompts), 2)
            self.assertEqual(prompts[0]["id"], "p-foo")
            self.assertEqual(prompts[0]["metadata"]["tone"], "warm")
            self.assertEqual(prompts[0]["metadata"]["extra"], "x")
            self.assertEqual(prompts[1]["id"], "p-0002")
            self.assertEqual(prompts[1]["metadata"]["extra"], "y")


class TestMatrixExpansion(unittest.TestCase):
    def test_expand_matrix_blocks_cartesian(self) -> None:
        defaults = {"n": 1}
        blocks = [
            {
                "provider": "openai",
                "model": ["gpt-image-1.5", "gpt-image-1-mini"],
                "size": ["1024x1024", "1024x1536"],
                "seed": [1, 2],
                "provider_options": {"quality": ["low", "high"]},
            }
        ]
        expanded = param_forge._expand_matrix_blocks(blocks, defaults)
        self.assertEqual(len(expanded), 16)
        qualities = {item["provider_options"]["quality"] for item in expanded}
        self.assertEqual(qualities, {"low", "high"})

    def test_apply_excludes_nested(self) -> None:
        params_list = [
            {
                "provider": "openai",
                "model": "gpt-image-1.5",
                "size": "1024x1024",
                "provider_options": {"quality": "low"},
            },
            {
                "provider": "openai",
                "model": "gpt-image-1.5",
                "size": "1024x1024",
                "provider_options": {"quality": "high"},
            },
        ]
        excludes = [{"provider": "openai", "provider_options": {"quality": "low"}}]
        filtered = param_forge._apply_excludes(params_list, excludes)
        self.assertEqual(len(filtered), 1)
        self.assertEqual(filtered[0]["provider_options"]["quality"], "high")

    def test_build_experiment_jobs(self) -> None:
        prompts = [{"id": "p-0001", "prompt": "Hello", "metadata": {"tag": "a"}}]
        params_list = [
            {
                "provider": "openai",
                "model": "gpt-image-1.5",
                "size": "1024x1024",
                "n": 2,
                "provider_options": {"quality": "high"},
            }
        ]
        jobs = param_forge._build_experiment_jobs(prompts=prompts, params_list=params_list)
        self.assertEqual(len(jobs), 1)
        job = jobs[0]
        self.assertEqual(job["job_id"], "j-000001")
        self.assertEqual(job["prompt_id"], "p-0001")
        self.assertEqual(job["prompt_metadata"]["tag"], "a")


class TestExploreHelpers(unittest.TestCase):
    def test_normalize_provider_and_model_google(self) -> None:
        provider, model = param_forge._normalize_provider_and_model("google", "imagen-4")
        self.assertEqual(provider, "imagen")
        self.assertEqual(model, "imagen-4")
        provider, model = param_forge._normalize_provider_and_model("google", "gemini-2.5-flash-image")
        self.assertEqual(provider, "gemini")
        self.assertEqual(model, "gemini-2.5-flash-image")

    def test_model_choices_for_aliases(self) -> None:
        google_models = param_forge._model_choices_for("google")
        self.assertTrue(any("gemini" in item for item in google_models))
        self.assertTrue(any("imagen" in item for item in google_models))
        flux_models = param_forge._model_choices_for("black forest labs")
        self.assertTrue(any("flux" in item for item in flux_models))

    def test_build_interactive_namespace_defaults(self) -> None:
        args = param_forge._build_interactive_namespace(
            "openai",
            "gpt-image-1.5",
            "Hello world",
            "1024x1024",
            1,
            "outputs/param_forge",
        )
        self.assertEqual(args.provider, "openai")
        self.assertEqual(args.model, "gpt-image-1.5")
        self.assertEqual(args.prompt, ["Hello world"])
        self.assertEqual(args.size, "1024x1024")
        self.assertEqual(args.n, 1)
        self.assertEqual(args.out, "outputs/param_forge")


class TestProviderResolution(unittest.TestCase):
    def test_imagen_ratio_remap(self) -> None:
        request = ImageRequest(prompt="Hello", provider="imagen", size="4:5")
        resolved = resolve_request(request, "imagen")
        self.assertEqual(resolved.provider_params.get("aspect_ratio"), "3:4")
        self.assertTrue(
            any("Imagen does not support 4:5" in str(warn) for warn in resolved.warnings)
        )

    def test_flux_model_alias(self) -> None:
        request = ImageRequest(prompt="Hello", provider="flux", model="flux-2")
        resolved = resolve_request(request, "flux")
        self.assertEqual(resolved.model, "flux-2-flex")
        self.assertTrue(any("flux-2 is deprecated" in str(warn) for warn in resolved.warnings))


if __name__ == "__main__":
    unittest.main()
