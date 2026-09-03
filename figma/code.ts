figma.showUI(__html__, {
  width: 300,
  height: 82,
  themeColors: true
});

type BridgeRequest = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

type BridgeResponse = {
  id: string;
  result?: unknown;
  error?: string;
};

type ResizableSceneNode = SceneNode & {
  resize(width: number, height: number): void;
};

function serializable(value: unknown): unknown {
  return value === figma.mixed ? "MIXED" : value;
}

function isResizable(node: SceneNode): node is ResizableSceneNode {
  return "resize" in node && typeof node.resize === "function";
}

function summarize(node: SceneNode, depth: number): Record<string, unknown> {
  const output: Record<string, unknown> = {
    id: node.id,
    type: node.type,
    name: node.name,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    visible: node.visible,
    locked: node.locked
  };

  if ("opacity" in node) {
    output.opacity = node.opacity;
  }

  if (node.type === "TEXT") {
    output.text = {
      characters: node.characters,
      fontName: serializable(node.fontName),
      fontSize: serializable(node.fontSize),
      textAlignHorizontal: node.textAlignHorizontal,
      textAlignVertical: node.textAlignVertical,
      textAutoResize: node.textAutoResize
    };
  }

  if ("layoutMode" in node) {
    const layoutNode = node as unknown as {
      layoutMode: string;
      layoutWrap?: string;
      itemSpacing: number;
      counterAxisSpacing?: number | null;
      paddingTop: number;
      paddingRight: number;
      paddingBottom: number;
      paddingLeft: number;
      primaryAxisAlignItems: string;
      counterAxisAlignItems: string;
      layoutSizingHorizontal?: string;
      layoutSizingVertical?: string;
    };

    output.autoLayout = {
      mode: layoutNode.layoutMode,
      wrap: layoutNode.layoutWrap,
      gap: layoutNode.itemSpacing,
      counterAxisGap: layoutNode.counterAxisSpacing,
      padding: {
        top: layoutNode.paddingTop,
        right: layoutNode.paddingRight,
        bottom: layoutNode.paddingBottom,
        left: layoutNode.paddingLeft
      },
      primaryAxisAlignItems: layoutNode.primaryAxisAlignItems,
      counterAxisAlignItems: layoutNode.counterAxisAlignItems,
      sizingHorizontal: layoutNode.layoutSizingHorizontal,
      sizingVertical: layoutNode.layoutSizingVertical
    };
  }

  if (depth > 0 && "children" in node) {
    output.children = node.children.map((child) =>
      summarize(child as SceneNode, depth - 1)
    );
  }

  return output;
}

async function resolveSceneNode(nodeId?: string): Promise<SceneNode> {
  if (nodeId) {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node || node.type === "DOCUMENT" || node.type === "PAGE") {
      throw new Error(`Scene node not found: ${nodeId}`);
    }
    return node as SceneNode;
  }

  const selection = figma.currentPage.selection;
  if (selection.length !== 1) {
    throw new Error(
      `Expected exactly one selected node, found ${selection.length}`
    );
  }
  return selection[0];
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = optionalString(params, key);
  if (value === undefined) throw new Error(`${key} is required`);
  return value;
}

function optionalPositiveNumber(
  params: Record<string, unknown>,
  key: string
): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive finite number`);
  }
  return value;
}

function boundedDepth(params: Record<string, unknown>, fallback: number): number {
  const value = params.depth;
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("depth must be an integer");
  }
  return Math.max(0, Math.min(value, 8));
}

async function loadFontsForText(node: TextNode): Promise<void> {
  if (node.hasMissingFont) {
    throw new Error(`Text node ${node.id} has missing fonts`);
  }

  const fonts: FontName[] = [];
  if (node.characters.length > 0) {
    fonts.push(...node.getRangeAllFontNames(0, node.characters.length));
  } else if (node.fontName !== figma.mixed) {
    fonts.push(node.fontName);
  } else {
    throw new Error(`Cannot determine the font for empty mixed-font text node ${node.id}`);
  }

  const unique = new Map<string, FontName>();
  for (const font of fonts) {
    unique.set(`${font.family}\u0000${font.style}`, font);
  }
  await Promise.all([...unique.values()].map((font) => figma.loadFontAsync(font)));
}

async function execute(request: BridgeRequest): Promise<unknown> {
  const params = request.params ?? {};

  switch (request.method) {
    case "get_selection": {
      const depth = boundedDepth(params, 3);
      return figma.currentPage.selection.map((node) => summarize(node, depth));
    }

    case "get_node": {
      const node = await resolveSceneNode(requiredString(params, "nodeId"));
      return summarize(node, boundedDepth(params, 3));
    }

    case "resize": {
      const node = await resolveSceneNode(optionalString(params, "nodeId"));
      if (!isResizable(node)) {
        throw new Error(`${node.type} nodes cannot be resized by this bridge`);
      }
      const width = optionalPositiveNumber(params, "width") ?? node.width;
      const height = optionalPositiveNumber(params, "height") ?? node.height;
      node.resize(width, height);
      figma.commitUndo();
      return summarize(node, 1);
    }

    case "set_text": {
      const node = await resolveSceneNode(optionalString(params, "nodeId"));
      if (node.type !== "TEXT") {
        throw new Error(`Expected a TEXT node, got ${node.type}`);
      }
      await loadFontsForText(node);
      node.characters = requiredString(params, "text");
      figma.commitUndo();
      return summarize(node, 1);
    }

    case "undo": {
      figma.triggerUndo();
      return { ok: true };
    }

    default:
      throw new Error(`Unknown bridge method: ${request.method}`);
  }
}

figma.ui.onmessage = async (message: unknown) => {
  if (
    typeof message !== "object" ||
    message === null ||
    !("type" in message) ||
    message.type !== "bridge-request" ||
    !("request" in message)
  ) {
    return;
  }

  const request = message.request as BridgeRequest;
  let response: BridgeResponse;

  try {
    response = {
      id: request.id,
      result: await execute(request)
    };
  } catch (error) {
    response = {
      id: request.id,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  figma.ui.postMessage({
    type: "bridge-response",
    response
  });
};
