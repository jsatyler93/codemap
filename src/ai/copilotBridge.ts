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
  "You are a senior code tour writer for a code understanding tool.",
  "You will receive a structured summary of a code function call graph including function names, source context, docstrings, call order, type information, and confidence cues.",
  "Write a lively but technically accurate guided walkthrough for an engineer who wants to understand the pipeline quickly.",
  "Prefer specific, grounded explanations over hype. Mention uncertainty when the evidence is weak.",
  "Return one valid JSON object with these top-level fields:",
  '- "title": short title for the walkthrough',
  '- "overview": 2 to 4 sentences describing what the pipeline is for and how it is organized',
  '- "opening": 1 to 2 sentences that frame the tour and why it matters',
  '- "takeaways": array of 2 to 4 short takeaway strings',
  '- "sections": optional array of objects with fields "id", "title", "summary", optional "intent", optional "stepNodeIds"',
  '- "steps": ordered array aligned to the input execution timeline',
  "Each steps element must have:",
  '- "edgeIndex": integer (0-based, matches the input step order)',
  '- "title": short beat title',
  '- "narration": 2 or 3 sentences explaining what happens and why it matters in this pipeline',
  '- "whyItMatters": short clause describing the local significance',
  '- "evidence": optional array of short evidence strings grounded in the input',
  '- "confidence": optional string: high, medium, or low',
  '- "sectionId": optional section id if relevant',
  '- "durationHint": integer milliseconds between 1200 and 4200',
  "Return only valid JSON. No markdown fences. No preamble.",
].join(" ");

const FLOWCHART_SYSTEM_PROMPT = [
  "You are a senior code tour writer for a code understanding tool.",
  "You will receive a structured description of a function's control flow including node kinds, signatures, docstring summaries, transitions, and grouping.",
  "Write a concise guided explanation that helps an engineer understand what the function is doing, how control moves, where decisions split, and what loops are accomplishing.",
  "Prioritize speed and signal over exhaustiveness. Focus on the important beats only: entry, major decisions, loop headers and exits, outputs, errors, and only the most important helper steps.",
  "Do not narrate every trivial process node. Merge straightforward setup or repeated low-information nodes into higher-level beats.",
  "Be vivid and informative, but stay grounded in the provided evidence.",
  "Return one valid JSON object with these top-level fields:",
  '- "title": short title for the walkthrough',
  '- "overview": 2 or 3 sentences describing the function and its high-level flow',
  '- "opening": 1 or 2 sentences setting up the tour',
  '- "takeaways": array of 2 to 4 short takeaway strings',
  '- "sections": optional array of objects with fields "id", "title", "summary", optional "intent", optional "stepNodeIds"',
  '- "steps": ordered array of node narration beats',
  'For large functions, keep the steps array brief. Target 6 to 12 beats, and never exceed 12 beats.',
  "Each steps element must have:",
  '- "nodeId": the id field from the input',
  '- "title": short beat title',
  '- "narration": 1 or 2 short sentences explaining what this node or beat does in the surrounding control flow',
  '- "whyItMatters": short clause describing the role of this node',
  '- "evidence": optional array of short evidence strings grounded in the input',
  '- "confidence": optional string: high, medium, or low',
  '- "sectionId": optional section id if relevant',
  '- "durationHint": integer milliseconds between 1000 and 2600',
  "Return only valid JSON. No markdown fences. No preamble.",
].join(" ");

const NODE_SYSTEM_PROMPT = [
  "You are a senior code tour writer for a code understanding tool.",
  "You will receive a structured description of one graph node from a code visualization.",
  "Return only a valid JSON object with fields:",
  '- "title": short beat title',
  '- "narration": 2 or 3 sentences describing what the node does and why it matters',
  '- "whyItMatters": short clause describing the role of the node',
  '- "evidence": optional array of short evidence strings grounded in the input',
  '- "confidence": optional string: high, medium, or low',
  '- "durationHint": integer milliseconds between 1200 and 3200',
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
