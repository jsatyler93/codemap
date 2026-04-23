import * as vscode from "vscode";

const LAST_MODEL_ID_KEY = "codemap.narration.lastModelId";

export interface NarrationModelChoice {
  model: vscode.LanguageModelChat;
  selectionMode: "auto" | "manual";
}

interface ModelQuickPickItem extends vscode.QuickPickItem {
  model?: vscode.LanguageModelChat;
  selectionMode: "auto" | "manual";
}

const TRACE_SYSTEM_PROMPT = [
  "You are a code documentation assistant.",
  "You will receive a structured summary of a code function call graph including function names, docstrings, call order, and type information.",
  "Produce a JSON object with a top-level string field named overview and a top-level array field named steps.",
  "Each steps element must have:",
  '- "edgeIndex": integer (0-based, matches the input step order)',
  '- "narration": a single clear sentence, max 25 words, explaining what that call does in the context of the overall pipeline',
  '- "durationHint": integer milliseconds between 800 and 2500',
  "Return only valid JSON. No markdown fences. No preamble.",
].join(" ");

const FLOWCHART_SYSTEM_PROMPT = [
  "You are a code documentation assistant.",
  "You will receive a structured description of a function's control flow including node kinds, type information, and docstring summaries.",
  "Return only a valid JSON array.",
  "Each array element must have:",
  '- "nodeId": the id field from the input',
  '- "annotation": one sentence explaining what this node does in plain English',
  "No markdown fences. No preamble.",
].join(" ");

const NODE_SYSTEM_PROMPT = [
  "You are a code documentation assistant.",
  "You will receive a structured description of one graph node from a code visualization.",
  "Return only a valid JSON object with fields:",
  '- "narration": one concise sentence describing the node',
  '- "durationHint": integer milliseconds between 800 and 2500',
  "No markdown fences. No preamble.",
].join(" ");

export async function pickNarrationModel(
  context: vscode.ExtensionContext,
  options: { title?: string; allowAuto?: boolean } = {},
): Promise<NarrationModelChoice | undefined> {
  const models = await getCopilotModels();
  const storedModelId = context.workspaceState.get<string>(LAST_MODEL_ID_KEY);
  const items: ModelQuickPickItem[] = [];

  if (options.allowAuto ?? true) {
    const autoModel = pickPreferredModel(models, storedModelId);
    items.push({
      label: "Auto",
      description: autoModel ? `${autoModel.name} · ${autoModel.family}` : "Recommended available model",
      detail: autoModel ? modelDetail(autoModel) : "Pick the best available Copilot chat model automatically.",
      model: autoModel,
      selectionMode: "auto",
      alwaysShow: true,
    });
  }

  for (const model of sortModels(models)) {
    items.push({
      label: model.name,
      description: `${model.family}${model.version ? ` · ${model.version}` : ""}`,
      detail: modelDetail(model),
      model,
      selectionMode: "manual",
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: options.title ?? "CodeMap Narration: Choose Model",
    placeHolder: "Select the Copilot model to use for narration",
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  if (!picked?.model) {
    return undefined;
  }
  await context.workspaceState.update(LAST_MODEL_ID_KEY, picked.model.id);
  return { model: picked.model, selectionMode: picked.selectionMode };
}

export async function resolveNarrationModel(
  context: vscode.ExtensionContext,
  interactive: boolean,
): Promise<NarrationModelChoice | undefined> {
  if (interactive) {
    return pickNarrationModel(context, { allowAuto: true });
  }
  const models = await getCopilotModels();
  const storedModelId = context.workspaceState.get<string>(LAST_MODEL_ID_KEY);
  const model = pickPreferredModel(models, storedModelId);
  if (!model) {
    return undefined;
  }
  return { model, selectionMode: "auto" };
}

export async function narrateTrace(
  serializedContext: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<string> {
  return sendNarrationRequest(model, TRACE_SYSTEM_PROMPT, serializedContext, token);
}

export async function narrateFlowchart(
  serializedContext: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<string> {
  return sendNarrationRequest(model, FLOWCHART_SYSTEM_PROMPT, serializedContext, token);
}

export async function narrateNode(
  serializedContext: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<string> {
  return sendNarrationRequest(model, NODE_SYSTEM_PROMPT, serializedContext, token);
}

async function getCopilotModels(): Promise<vscode.LanguageModelChat[]> {
  const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
  if (!models.length) {
    throw new Error("GitHub Copilot chat models are not available. Make sure Copilot is installed and you are signed in.");
  }
  return models;
}

function sortModels(models: readonly vscode.LanguageModelChat[]): vscode.LanguageModelChat[] {
  return [...models].sort((left, right) => {
    const scoreDiff = scoreModel(right) - scoreModel(left);
    if (scoreDiff !== 0) return scoreDiff;
    const familyCmp = left.family.localeCompare(right.family);
    if (familyCmp !== 0) return familyCmp;
    const versionCmp = right.version.localeCompare(left.version);
    if (versionCmp !== 0) return versionCmp;
    return left.name.localeCompare(right.name);
  });
}

function pickPreferredModel(
  models: readonly vscode.LanguageModelChat[],
  preferredId?: string,
): vscode.LanguageModelChat | undefined {
  if (preferredId) {
    const preferred = models.find((model) => model.id === preferredId);
    if (preferred) return preferred;
  }
  return sortModels(models)[0];
}

function scoreModel(model: vscode.LanguageModelChat): number {
  const family = `${model.family} ${model.name}`.toLowerCase();
  let score = 0;
  if (family.includes("gpt-5.4")) score += 600;
  else if (family.includes("gpt-5")) score += 500;
  else if (family.includes("gpt-4.1")) score += 450;
  else if (family.includes("gpt-4o")) score += 400;
  else if (family.includes("claude opus")) score += 360;
  else if (family.includes("claude sonnet")) score += 320;
  else if (family.includes("o1")) score += 300;
  score += Math.min(200, Math.floor((model.maxInputTokens || 0) / 2048));
  return score;
}

function modelDetail(model: vscode.LanguageModelChat): string {
  const parts = [model.vendor, model.id];
  if (model.maxInputTokens) {
    parts.push(`${model.maxInputTokens.toLocaleString()} input tokens`);
  }
  return parts.join(" · ");
}

async function sendNarrationRequest(
  model: vscode.LanguageModelChat,
  systemPrompt: string,
  serializedContext: string,
  token: vscode.CancellationToken,
): Promise<string> {
  const messages = [
    vscode.LanguageModelChatMessage.User(systemPrompt),
    vscode.LanguageModelChatMessage.User(serializedContext),
  ];
  try {
    const response = await model.sendRequest(messages, {}, token);
    let text = "";
    for await (const chunk of response.text) {
      text += chunk;
    }
    return text;
  } catch (error) {
    if (error instanceof vscode.LanguageModelError) {
      throw new Error(`Narration request failed: ${error.message}`);
    }
    throw error;
  }
}
