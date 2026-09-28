# Skills — catálogo regularizado

Skills de terceiros + skill própria, agrupadas por domínio. Cada skill mantém o
seu `LICENSE` na própria pasta e o frontmatter regularizado (`name`,
`description`, `license`, `metadata`).

> **Regra:** não editar o conteúdo de skills vendorizadas — para adaptar,
> criar uma skill nova. A skill `anycubic-slicer-control` é original deste
> repositório e licenciada sob MIT (LICENSE na própria pasta), alinhada com o
> `package.json` do repo.

---

## Estrutura por domínio

```
skills/
├── 1-cad-parametric/        Modelação CAD paramétrica (código → geometria)
├── 2-review-validation/     Revisão visual e validação de printability
├── 3-printing/              Slicing, G-code e controlo de impressoras
├── 4-parts-drawings/        Peças normalizadas e desenhos 2D
├── 5-metrology-standards/   Metrologia, incerteza e conformidade ISO
├── 6-product-design/        Design industrial e ciclo de vida
└── VENDORED-SKILLS.md       Este catálogo
```

---

## 1-cad-parametric — CAD paramétrico

| Skill                    | Origem                                                                                      | Licença    | Função                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------ |
| `cad`                    | [earthtojake/text-to-cad](https://github.com/earthtojake/text-to-cad)                       | MIT        | CAD paramétrico (build123d), export STEP/STL/3MF/GLB, medição de geometria     |
| `cad-khana`              | [cyberchitta/cad-khana](https://github.com/cyberchitta/cad-khana)                           | Apache-2.0 | Wrapper build123d com assertions de interferência/folga e printability         |
| `lab-hardware-cad`       | [K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) | MIT        | Hardware de laboratório paramétrico; tabelas de tolerância/fit, MMC, ANSI/SLAS |
| `vibe-cad`               | [luckiday/vibe-hardware](https://github.com/luckiday/vibe-hardware)                         | MIT        | Enclosure/bracket paramétrico, interference check, export STEP/STL             |
| `synthcad-cad-authoring` | [BenCaunt/SynthCAD](https://github.com/BenCaunt/SynthCAD)                                   | MIT        | Autoria/validação de projetos build123d com testes locais                      |
| `openscad`               | [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff)                           | Apache-2.0 | Modelos OpenSCAD paramétricos, previews multi-ângulo, export STL               |

**Nota de sobreposição:** todas geram geometria via código. Diferenciação:
`cad` = generalista; `cad-khana` = diagnóstico/assertions; `lab-hardware-cad` =
labware/standards; `vibe-cad` = enclosures com viewer; `synthcad` = workflow de
autoria com testes; `openscad` = linguagem alternativa ao Python.

## 2-review-validation — Revisão e validação

| Skill        | Origem                                                                | Licença | Função                                                         |
| ------------ | --------------------------------------------------------------------- | ------- | -------------------------------------------------------------- |
| `cad-viewer` | [earthtojake/text-to-cad](https://github.com/earthtojake/text-to-cad) | MIT     | Visualizador de `.step/.stl/.3mf/.dxf/.glb` para revisão       |
| `dfam-check` | [earthtojake/text-to-cad](https://github.com/earthtojake/text-to-cad) | MIT     | Valida malhas contra regras DfAM (FDM, SLS, SLA/DLP, PBF, MJF) |

## 3-printing — Impressão

| Skill                     | Origem                                                                | Licença       | Função                                                                  |
| ------------------------- | --------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------- |
| `3d-print`                | [parhamdb/3d-print-skill](https://github.com/parhamdb/3d-print-skill) | MIT           | Workflow completo: requisitos → CAD → verificação → slicing → impressão |
| `gcode`                   | [earthtojake/text-to-cad](https://github.com/earthtojake/text-to-cad) | MIT           | Gera/valida G-code FDM orquestrando slicer CLIs                         |
| `bambu-labs`              | [earthtojake/text-to-cad](https://github.com/earthtojake/text-to-cad) | MIT           | Handoff local Bambu Lab (FTPS/MQTT)                                     |
| `anycubic-slicer-control` | **Este repositório**                                                  | MIT (própria) | Slicing e controlo Anycubic via MCP tools                               |

**Nota de sobreposição:** `3d-print` é o workflow end-to-end (usa `gcode`
internamente); `gcode` = só slicing/validação; `bambu-labs` e
`anycubic-slicer-control` = handoff específico por marca. Não usar
`bambu-labs` com impressoras Anycubic e vice-versa.

## 4-parts-drawings — Peças e desenhos

| Skill        | Origem                                                                | Licença | Função                                                                     |
| ------------ | --------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------- |
| `step-parts` | [earthtojake/text-to-cad](https://github.com/earthtojake/text-to-cad) | MIT     | Descarrega peças catalogadas (parafusos, rolamentos, servos) de step.parts |
| `dxf`        | [earthtojake/text-to-cad](https://github.com/earthtojake/text-to-cad) | MIT     | Gera/valida desenhos 2D DXF (perfis, juntas, corte laser)                  |

## 5-metrology-standards — Metrologia e normas

| Skill                     | Origem                                                                                      | Licença | Função                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------- |
| `uncertainty-and-units`   | [K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) | MIT     | Unidades (pint), orçamentos GUM, propagação de incerteza, Monte Carlo |
| `iso-standards-readiness` | [K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) | MIT     | Evidência de readiness ISO 13485 / 14971 / 17025 / 15189              |

## 6-product-design — Design de produto

| Skill                    | Origem                                                              | Licença | Função                                                                           |
| ------------------------ | ------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------- |
| `vibe-industrial-design` | [luckiday/vibe-hardware](https://github.com/luckiday/vibe-hardware) | MIT     | Aparência externa: renders three.js/Blender, medição de imagens IA, relatório ID |
| `vibe-plm`               | [luckiday/vibe-hardware](https://github.com/luckiday/vibe-hardware) | MIT     | Manifest de produto + contratos de interface entre domínios, gate de release     |

---

## Skills NÃO integradas (licença incompatível)

| Skill                    | Origem                                                                                  | Licença                          | Motivo                       |
| ------------------------ | --------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------- |
| `parametric-3d-printing` | [flowful-ai/cad-skill](https://github.com/flowful-ai/cad-skill)                         | **PolyForm Noncommercial 1.0.0** | Proíbe uso comercial         |
| `3dp-cad`                | [halr9000/3dp-cad](https://github.com/halr9000/3dp-cad)                                 | **CC BY-NC-ND 4.0**              | Proíbe comercial e derivados |
| `skill-modelagem-3d`     | [diegocamara89/skill-modelagem-3d](https://github.com/diegocamara89/skill-modelagem-3d) | **Sem LICENSE**                  | Todos os direitos reservados |

Se precisares destas funcionalidades, usa-as como **referência conceptual**
(ler a documentação e reimplementar) em vez de copiar o código.

---

## Regularização aplicada (2026-09-18)

- Frontmatter de **todas** as 18 skills normalizado: `name`, `description`,
  `license`, `metadata` (version, skill-author, vendored).
- Reorganização em 6 grupos de domínio (as skills mudaram de caminho; o
  `name:` interno não mudou).
- Verificado: nenhum ficheiro vazio; `_common.py` dos 3 skills K-Dense são
  distintos (hashes diferentes) — não são duplicados removíveis.

## Lacunas conhecidas (não existe skill pública)

| Área                          | Estado                                                                |
| ----------------------------- | --------------------------------------------------------------------- |
| **ISO 11608** (pen injectors) | ❌ Nenhuma skill pública — construir de raiz para o `minimal-pep-pen` |
| **GD&T formal**               | ❌ Nenhuma skill dedicada                                             |
| **Reparação de malhas STL**   | ❌ Nenhuma skill dedicada                                             |
| **CNC / maquinagem**          | ❌ Nenhuma skill verificada                                           |
| **IGES**                      | ⚠️ Não coberto pelas skills de conversão                              |

---

## Como usar

As skills são carregadas automaticamente pelo agente quando a tarefa corresponde
à `description` do `SKILL.md`. Para forçar uma skill, menciona o domínio na
pergunta (ex.: "valida esta malha para FDM" → `2-review-validation/dfam-check`).

### Combinações recomendadas para o `minimal-pep-pen`

| Objetivo                              | Skills                                        |
| ------------------------------------- | --------------------------------------------- |
| Modelar o alojamento do cartucho      | `1-cad-parametric/cad` + `vibe-cad`           |
| Validar folgas e interferências       | `cad-khana` + `lab-hardware-cad`              |
| Verificar printability                | `2-review-validation/dfam-check` + `3d-print` |
| Tolerâncias e incerteza dimensional   | `lab-hardware-cad` + `uncertainty-and-units`  |
| Documentação regulatória              | `iso-standards-readiness`                     |
| Peças normalizadas (parafusos, molas) | `step-parts`                                  |
| Desenhos 2D para corte                | `dxf`                                         |
| Aparência/ergonomia da caneta         | `vibe-industrial-design`                      |
| Slicing e impressão Anycubic          | `anycubic-slicer-control`                     |

---

## Atualização

Para atualizar uma skill, re-clonar a origem e substituir a pasta, mantendo o
`LICENSE` e reaplicando a regularização do frontmatter.

| Skill     | Commit de origem            | Data       |
| --------- | --------------------------- | ---------- |
| _(todas)_ | clone `--depth 1` de `main` | 2026-09-18 |
