# Blender headless — PoC de renderização fiel de modelos 3D

> Status: **funcional** (validado com Blender 5.2.2 LTS MSIX).
> Gera uma imagem PNG **geometricamente exata** de um mesh STL/OBJ/3MF — sem IA,
> sem GUI, 100% headless. A imagem é o próprio mesh: dimensões exatas.

---

## 1. Porquê Blender (e não difusão)

| | Difusão (TT-Images etc.) | Blender headless (este PoC) |
|---|---|---|
| Fidelidade dimensional | ~nenhuma (semântica) | **exata** (a imagem É a geometria) |
| Reprodutibilidade | zero (mesmo prompt → imagens diferentes) | **determinística** (mesmo mesh+seed → mesma imagem) |
| Custos | créditos API | 0 (local, CPU ou GPU) |
| Latência típica | 5–20 s | 2–10 s CPU (Cycles pode ser mais) |

## 2. Blender neste sistema (MSIX/Store)

O Blender instalado é a versão **Microsoft Store** (MSIX), o que traz duas
peculiaridades que o PoC já trata:

- O `blender.exe` dentro de uma pasta `WindowsApps` **não pode ser
  executado diretamente** (Access denied — precisa de package identity).
- O ponto de entrada correto é o **app execution alias**:
  `%LOCALAPPDATA%\Microsoft\WindowsApps\blender-launcher.exe`
- O alias **não devolve stdout** quando capturado pelo PowerShell; a forma
  fiável de verificar execução é **fazer o Blender escrever ficheiros**.
  O PoC usa esse mecanismo (o PNG e o JSON de relatório são escritos pelo
  próprio Blender).

### Caminho para o PoC

```
alias:   %LOCALAPPDATA%\Microsoft\WindowsApps\blender-launcher.exe
pacote:  instalação MSIX do Blender (inacessível diretamente em algumas versões)
versão:  5.2.2 LTS
```

> O `render-headless.mjs` resolve o caminho automaticamente nesta ordem:
> 1. `BLENDER_EXE` (env var)
> 2. `%LOCALAPPDATA%\Microsoft\WindowsApps\blender-launcher.exe` (Store)
> 3. uma instalação clássica do Blender em `Program Files`
> 4. `blender` no `PATH`

## 3. Uso

```sh
node tools/render-headless.mjs modelo.stl --out renders/modelo.png
node tools/render-headless.mjs modelo.3mf --view front --engine eevee --samples 64
node tools/render-headless.mjs modelo.stl --width 1920 --height 1080 --zoom 1.2
```

Opções:

| Flag | Default | Descrição |
|---|---|---|
| `--out <path>` | `renders/<nome>.png` | PNG de saída |
| `--view <v>` | `iso` | `iso`, `front`, `side`, `top`, `back`, `bottom`, `left`, `right` |
| `--engine <e>` | `eevee` | `eevee` (rápido) ou `cycles` (ray tracing) |
| `--samples <n>` | `128` | amostras (só cycles) |
| `--width/--height` | `1024`/`1024` | resolução do render |
| `--zoom <z>` | `1.0` | >1 aproxima, <1 afasta |
| `--rotate-x/y/z` | `0` | rotação extra em graus |
| `--bg <r,g,b>` | `240,240,240` | cor de fundo |

Saída: o PNG + um JSON `_report.json` com bounding box (mm), câmara, motor e
tempos — para auditoria de fidelidade.

## 4. O que o script Blender faz (por dentro)

1. Importa o mesh (`bpy.ops.wm.obj_import` / `wm.stl_import` / `wm.read_3mf`).
2. Calcula a bounding box real (dimensões em mm vão para o relatório).
3. Enquadra a câmara automaticamente (distância derivada da bbox × zoom).
4. Iluminação de 3 pontos (key/fill/rim) — determinística, sem RNG.
5. Renderiza com EEVEE (rápido) ou Cycles (fotorrealista), guarda PNG.

## 5. Integração com o agente CAD Visualizer

O agente `.github/agents/cad-visualizer.agent.md` usa este script como
**fidelity path**: exporta o mesh pelo CAD MCP, chama este renderizador e
apresenta o PNG como render fiel (com a bbox do relatório como prova).

## 6. Limitações conhecidas (MSIX)

- stdout/stderr do Blender não são capturáveis; progresso vem do ficheiro JSON
  escrito no fim (`_report.json` = sucesso).
- `--background -b` ambos funcionam; o launcher é whoami-consistente.
- Se um dia instalares a versão clássica (zip/installer), o resolvedor apanha-a
  automaticamente (ordem acima).

## 7. Próximos passos (fora do âmbito deste PoC)

- Multicolor: mesma abordagem programática — segmentar textura em faces
  (open source: `DitherForge` MIT, `paint-to-print-3d` MIT) e exportar 3MF
  com materiais por face. O Blender também consegue via material slots +
  `bpy.ops.export_scene.gltf` / extensões 3MF.
- Image→3D local open weights: TripoSR (MIT) quando precisares de mesh a
  partir de foto — mas para fidelidade, o caminho é sempre o CAD paramétrico.
