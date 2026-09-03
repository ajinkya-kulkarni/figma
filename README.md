# OpenCode ↔ Figma Live Bridge

A small local bridge that lets OpenCode inspect and modify the **currently open Figma document** through a development plugin.

This is intentionally an MVP. It proves the live round trip before adding broader Figma semantics such as components, variables, cloning, auto-layout mutation, and prototype links.

## What works

The MCP server exposes these tools:

- `figma_status` — check whether the Figma plugin is connected.
- `figma_get_selection` — inspect the current Figma selection and a bounded child tree.
- `figma_get_node` — inspect a node by Figma node ID.
- `figma_resize` — resize a node or the single selected node.
- `figma_set_text` — edit a text node or the single selected text node.
- `figma_undo_last_change` — undo the last bridge mutation.

Resize and text mutations call `figma.commitUndo()`, so each bridge write gets its own Figma undo boundary.

## Architecture

```text
OpenCode
   │ MCP over stdio
   ▼
Node MCP process
   │ WebSocket on 127.0.0.1:7331
   ▼
Figma plugin UI iframe
   │ postMessage
   ▼
Figma plugin main thread
   │ Plugin API
   ▼
Live Figma document
```

The WebSocket server binds only to `127.0.0.1`.

## Prerequisites

- Node.js 20+
- OpenCode V2
- Figma Desktop for local plugin development/testing

## 1. Clone and build

```bash
git clone https://github.com/ajinkya-kulkarni/figma.git
cd figma
git checkout feat/live-figma-bridge
npm install
npm run check
```

`npm run check` type-checks both the Figma plugin and MCP server and builds:

```text
figma/dist/code.js
dist/mcp.js
```

## 2. Import the Figma development plugin

In **Figma Desktop**:

1. Open any Figma Design file.
2. Open **Plugins → Development → Import plugin from manifest…**.
3. Select `figma/manifest.json` from this repository.
4. Run **Plugins → Development → OpenCode Bridge**.
5. Leave the small plugin window open while you use OpenCode.

The development manifest uses plugin ID `0`. If your Figma client rejects that development ID, create a new Custom UI development plugin once in Figma and replace the `id` in `figma/manifest.json` with the numeric ID Figma generates.

The plugin may initially show `Waiting for OpenCode…`. That is expected until the MCP process starts.

## 3. Start OpenCode

This repository already contains `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "figma-live": {
        "type": "local",
        "command": ["node", "./dist/mcp.js"],
        "cwd": ".",
        "codemode": false
      }
    }
  }
}
```

From the repository root:

```bash
opencode
```

OpenCode starts the MCP process. The plugin window in Figma should change to:

```text
Connected to OpenCode
```

## 4. Smoke test the live round trip

### Connection

Ask OpenCode:

```text
Use figma_status and tell me whether Figma is connected.
```

### Read

Select a frame in Figma, then ask:

```text
Inspect my current Figma selection. Do not modify anything.
```

The tool returns compact structural data such as node IDs, hierarchy, dimensions, text, and auto-layout properties.

### Write: resize

With one frame selected:

```text
Make the selected Figma frame 500 px wide and keep its current height.
```

You should see the actual frame resize immediately in Figma.

### Write: text

Select a text layer and ask:

```text
Change the selected Figma text to "Account Settings".
```

The plugin loads the text layer's existing fonts before changing its characters.

### Undo

Ask:

```text
Undo the last Figma bridge change.
```

## Using the bridge from another OpenCode project

For the MVP, the easiest smoke test is to run OpenCode from this repository. To use the bridge while OpenCode is working in another codebase, copy the `figma-live` server entry into that project's OpenCode config and make the MCP command absolute, for example:

```jsonc
{
  "mcp": {
    "servers": {
      "figma-live": {
        "type": "local",
        "command": [
          "node",
          "/Users/YOU/path/to/figma/dist/mcp.js"
        ],
        "codemode": false
      }
    }
  }
}
```

Then OpenCode can see both your application repository and the live Figma MCP tools in the same session.

## Safety / scope

This MVP deliberately does **not** expose arbitrary JavaScript evaluation to the model. The agent can only use typed operations that we explicitly implement.

There are currently no delete, arbitrary reparent, component-detach, or broad document mutation tools.

## Next useful tools

Once the smoke test works reliably, the next layer should be:

1. `figma_get_screen_context` — richer compact screen serialization.
2. `figma_clone_node` and `figma_move_node`.
3. Auto-layout mutation: direction, gap, padding, sizing.
4. Components/instances/variant inspection and safe instance creation.
5. Variables/styles inspection and binding.
6. Creation tools for frames, text, and component instances.
7. Prototype/interactions inspection.

The goal is to keep the agent API high-level and constrained rather than mirroring every raw Plugin API property.
