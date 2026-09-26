# Optional Tools

This directory contains reusable offline utilities that are not part of the MCP server runtime.

- `3mf/` contains 3MF/STL inspection, generation, conversion, and repair helpers.
- `gcode/` contains layer-splicing, recovery, and G-code package verification helpers.
- `cad/` contains optional CAD-specific generators that retain versioned tests.

These tools must remain filesystem-oriented, avoid credentials, and be safe to run without a live printer.
