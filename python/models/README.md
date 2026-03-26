# Local Model Assets

This directory is for local-only model resources used during development and diagnostics.

Rules:
- Do not commit model weights or caches (`.ckpt`, `.pth`, `.pt`, `.onnx`, `.bin`, `.safetensors`).
- Keep only lightweight placeholders/notes in Git.
- Place guitar specialist checkpoints under `python/models/guitar/`.

Recommended local layout:
- `python/models/guitar/<model-slug>/<checkpoint-file>`
- `python/models/guitar/<model-slug>/<config-file>`

Current guitar specialist contract (orchestration):
- `ORCH_GUITAR_SPECIALIST_CMD`
- `ORCH_GUITAR_SPECIALIST_CHECKPOINT`
- `ORCH_GUITAR_SPECIALIST_MODEL_ID`
- `ORCH_GUITAR_SPECIALIST_RUNTIME_PROFILE_ID`
