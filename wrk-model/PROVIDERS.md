# LLM Inference Providers

One of the strongest use cases of this AI inference platform is **dynamic runtime model registration**: you can add and switch models without service restarts, enabling faster experimentation and production rollouts.

This worker is optimized around two runtime models:

- gemma3-1b on ollama
- phi2-2.7b on llama-cpp

## Prerequisites

By default, keep `ollama` explicitly configured but disabled in `wrk-model/config/common.json`:

```json
{
  "runtime": {
    "providers": [
      {
        "type": "llama-cpp",
        "enabled": true,
        "settings": {
          "modelBaseDir": "./models",
          "modelCacheDir": "./models/.cache"
        }
      },
      {
        "type": "ollama",
        "enabled": false,
        "endpoint": "http://localhost:11434"
      }
    ]
  }
}
```

Enable `ollama` only if an Ollama server is reachable from the model worker pod:

```json
{
  "type": "ollama",
  "enabled": true,
  "endpoint": "http://localhost:11434"
}
```

If needed:

```bash
cd wrk-model
npm install node-llama-cpp
```

## Register Runtime Models

Run both commands once:

```bash
MODEL_WORKER_RPC_KEY=622d1a72ed6a6438d762fa00e0fedbff7d04f3936d026aff705618afeb73bed5

npx hp-rpc-cli -s "$MODEL_WORKER_RPC_KEY" -m registerModel -d '{
  "id": "gemma3-1b",
  "provider": "ollama",
  "modelName": "gemma3:1b",
  "name": "Gemma 3 1B",
  "config": { "contextLength": 2048 }
}'

npx hp-rpc-cli -s "$MODEL_WORKER_RPC_KEY" -m registerModel -d '{
  "id": "phi2-2.7b",
  "provider": "llama-cpp",
  "name": "Phi-2 2.7B Q4",
  "modelPath": "phi-2.Q4_K_M.gguf",
  "autoload": true,
  "source": {
    "type": "huggingface",
    "repo": "TheBloke/phi-2-GGUF",
    "revision": "main",
    "files": ["phi-2.Q4_K_M.gguf"],
    "tokenEnv": "HF_TOKEN"
  },
  "config": {
    "contextLength": 2048,
    "format": "gguf",
    "quantization": "Q4_K_M"
  }
}' -t 600000
```

## What Gets Updated

- Any ollama model is registered in runtime model registry (only usable when `ollama` is enabled and reachable).
- tiny lamma is registered and downloaded from Hugging Face.
- GGUF artifacts are cached under wrk-model/models/.cache.
- llama-cpp models become available for /infer immediately; ollama models require enabled/reachable Ollama.

## Verify Inference

You can call /infer directly with either model ID:

- gemma3-1b
- phi2-2.7b

Example request body:

```json
{
  "modelId": "phi2-2.7b",
  "prompt": "Explain what an inference rack does.",
  "params": {
    "max_tokens": 120,
    "temperature": 0.7
  }
}
```

## Notes

- Use -t 600000 for first-time Phi-2 download.
- Keep autoload: true for Phi-2 so it is loaded immediately after registration.
- Ollama is disabled by default to keep the worker stable in environments without an Ollama sidecar/service.
- If you enable Ollama, it will try to connect local ollama endpoint to search for available models

## Unload Models (End of Run)

```bash
MODEL_WORKER_RPC_KEY=622d1a72ed6a6438d762fa00e0fedbff7d04f3936d026aff705618afeb73bed5

npx hp-rpc-cli -s "$MODEL_WORKER_RPC_KEY" -m unloadModel -d '{"modelId":"gemma3-1b"}'
npx hp-rpc-cli -s "$MODEL_WORKER_RPC_KEY" -m unloadModel -d '{"modelId":"phi2-2.7b"}'
```

Verify unload status:

```bash
npx hp-rpc-cli -s "$MODEL_WORKER_RPC_KEY" -m listModels
```
