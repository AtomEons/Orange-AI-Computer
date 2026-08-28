# Orange Navigator: AtomicChat Ornith 1.5 9B

## Canonical model source

- Publisher: AtomicChat
- Repository: `AtomicChat/Ornith-1.5-9B-GGUF`
- Repository revision: `8fc2368e779489ae43607253fc392ec2acae46f3`
- Artifact: `Ornith-1.5-9B-AD-Q4_K-IQ4_XS.gguf`
- Artifact bytes: `5611873024`
- Artifact SHA-256: `c18ed28de4477e35ddce0bf9ac025758bb0f5c5ebeb2c8f2955c4c36023010b6`
- Orange runtime tag: `orange-navigator:ornith-1.5-9b-q4km`

The Orange tag intentionally remains stable so the gateway, compute fabric,
Hermes profiles, and manuals do not drift. The backing model is the explicitly
sourced AtomicChat Dynamic GGUF above. The previous opaque 5.8 GB blob is not
accepted as provenance for this replacement.

The Orange Modelfile does not override `TEMPLATE`. Ollama must retain the chat,
reasoning, and tool-call template embedded by the model publisher. Orange adds
its system contract and bounded runtime parameters around that native template.

## Deployment

```powershell
ollama create orange-navigator:ornith-1.5-9b-q4km `
  -f C:/AtomEons/Orange5/13-MODELS/orange-navigator-atomicchat-ornith-1.5-9b.Modelfile
```

The artifact is installed on Codexa at:

```text
C:/AtomEons/models/ornith/Ornith-1.5-9B-AD-Q4_K-IQ4_XS.gguf
```

This model is the Navigator lane, not OrangeBrain itself. OrangeBrain remains
the deterministic orchestration and governance layer. Navigator interprets,
routes, and reports through that layer.
