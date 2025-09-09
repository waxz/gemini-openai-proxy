import type { Content, GenerateContentRequest, JsonSchema, Part } from "./gemini-api-client/types.ts"
import type { Any } from "./log.ts"
import type { OpenAI } from "./types.ts"

export interface ApiParam {
  apikey: string
  useBeta: boolean
}

export function getToken(headers: Iterable<[string, string]>): ApiParam | null {
  for (const [k, v] of headers) {
    if (k.toLowerCase() !== "authorization") continue

    const rawApikey = v.substring(v.indexOf(" ") + 1)

    if (!rawApikey.includes("#")) {
      return {
        apikey: rawApikey,
        useBeta: false,
      }
    }

    // todo read config from apikey
    const apikey = rawApikey.substring(0, rawApikey.indexOf("#"))
    const params = new URLSearchParams(rawApikey.substring(rawApikey.indexOf("#") + 1))
    return {
      apikey,
      useBeta: params.has("useBeta"),
    }
  }
  return null
}

function parseBase64(base64: string): Part {
  if (!base64.startsWith("data:")) {
    return { text: "" }
  }

  const [m, data, ..._arr] = base64.split(",")
  const mimeType = m.match(/:(?<mime>.*?);/)?.groups?.mime ?? "img/png"
  return {
    inlineData: {
      mimeType,
      data,
    },
  }
}

export function openAiMessageToGeminiMessage(messages: OpenAI.Chat.ChatCompletionMessageParam[]): Content[] {
  const result: Content[] = messages.flatMap(({ role, content }) => {
    if (role === "system") {
      return [
        {
          role: "user",
          parts: typeof content !== "string" ? content : [{ text: content }],
        },
      ] satisfies Content[] as Content[]
    }
    const parts: Part[] =
      content == null || typeof content === "string"
        ? [{ text: content?.toString() ?? "" }]
        : content.map((item) => {
            if (item.type === "text") return { text: item.text }
            if (item.type === "image_url") return parseBase64(item.image_url.url)
            return { text: "OK" }
          })
    return [{ role: "user" === role ? "user" : "model", parts: parts }]
  })

  return result
}

export function genModel(req: OpenAI.Chat.ChatCompletionCreateParams): [GeminiModel, GenerateContentRequest] {
  const model: GeminiModel = GeminiModel.modelMapping(req.model)

  let functions: OpenAI.Chat.FunctionObject[] =
    req.tools?.filter((it) => it.type === "function")?.map((it) => it.function) ?? []

  functions = functions.concat((req.functions ?? []).map((it) => ({ strict: null, ...it })))

  const [responseMimeType, responseSchema] = (() => {
    switch (req.response_format?.type) {
      case "json_object":
        return ["application/json", undefined]
      case "json_schema":
        return ["application/json", req.response_format.json_schema.schema satisfies JsonSchema | undefined]
      case "text":
        return ["text/plain", undefined]
      default:
        return [undefined, undefined]
    }
  })()

  const generateContentRequest: GenerateContentRequest = {
    contents: openAiMessageToGeminiMessage(req.messages),
    generationConfig: {
      maxOutputTokens: req.max_completion_tokens ?? undefined,
      temperature: req.temperature ?? undefined,
      topP: req.top_p ?? undefined,
      responseMimeType: responseMimeType,
      responseSchema: responseSchema,
      thinkingConfig: !model.isThinkingModel()
        ? undefined
        : {
            includeThoughts: true,
          },
    },
    tools:
      functions.length === 0
        ? undefined
        : [
            {
              functionDeclarations: functions,
            },
          ],
    safetySettings: (
      [
        "HARM_CATEGORY_HATE_SPEECH",
        "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        "HARM_CATEGORY_DANGEROUS_CONTENT",
        "HARM_CATEGORY_HARASSMENT",
      ] as const
    ).map((category) => ({
      category,
      threshold: "BLOCK_NONE",
    })),
  }
  return [model, generateContentRequest]
}
export type KnownGeminiModel =
  | "gemini-2.5-pro"
  | "gemini-2.5-flash"
  | "gemini-1.5-pro-latest"
  | "gemini-1.5-flash-latest"
  | "gemini-1.5-flash-8b-latest"
  | "gemini-2.0-pro-exp"
  | "gemini-2.0-flash-exp"
  | "gemma-3-4b-it"
  | "gemma-3-27b-it"
  | "text-embedding-004"
  | "fmtts"
const OAI_GEMINI_MAP_DEALFULT_MODEL = "gemma-3-4b-it"
export type API_VERSION = "v1beta" | "v1" | "v1alpha"

export class GeminiModel {
  static modelMapping(model: string | undefined): GeminiModel {
    const modelName: GeminiModelName | KnownGeminiModel =
      ModelMapping[model ?? ""] ?? GeminiModel.defaultModel(model ?? "")
    return new GeminiModel(modelName)
  }
  public readonly model: GeminiModelName
  constructor(model: GeminiModelName) {
    this.model = model
  }

  isThinkingModel(): boolean {
    return this.model.includes("thinking")
  }

  apiVersion(): API_VERSION {
    if (this.isThinkingModel()) {
      return "v1alpha"
    }
    return "v1beta"
  }

  toString(): string {
    return this.model
  }

  private static defaultModel(m: string): GeminiModelName {
    if (m.startsWith("gemini") || m.startsWith("gemma")) {
      return m as GeminiModelName
    }
    return OAI_GEMINI_MAP_DEALFULT_MODEL
  }
}

export type GeminiModelName =
  | `gemini${string}`
  | `gemma${string}`
  | "text-embedding-004"
  | "embedding-gecko-001"
  | "gemini-embedding-001"
  | "embedding-001"
  | "fmtts"
//https://platform.openai.com/docs/guides/embeddings/embedding-models
//https://ai.google.dev/gemini-api/docs/embeddings
export const ModelMapping: Readonly<Record<string, KnownGeminiModel>> = {
  // Updated with latest models
  "gpt-3.5-turbo": "gemini-1.5-flash-8b-latest", // ✅ Good match
  "gpt-4o": "gemini-2.5-flash", // Updated to newer model
  "gpt-4o-mini": "gemini-1.5-flash-8b-latest", // ✅ Good match
  "gpt-4": "gemini-2.5-pro", // Updated to newer model
  "gpt-4-vision-preview": "gemini-2.5-flash", // Better multimodal match
  "gpt-4-turbo": "gemini-2.5-pro", // Updated to newer model
  "gpt-4-turbo-preview": "gemini-2.5-pro", // Better capability match
  "gpt-4.1-nano": "gemini-1.5-flash-8b-latest", // More appropriate for smaller model
  "gpt-4.1-mini": "gemini-2.5-flash", // Better performance match
  "gpt-4.1": "gemini-2.5-pro", // Top-tier match
  "gpt-5-nano": "gemini-1.5-flash-8b-latest", // Conservative mapping
  "gpt-5-mini": "gemini-2.5-flash", // Performance-focused
  "gpt-5": "gemini-2.5-pro", // Best available match

  // Embeddings remain good
  "text-embedding-3-small": "text-embedding-004",
  "text-embedding-3-large": "text-embedding-004",
  "text-embedding-ada-002": "text-embedding-004",

  // TTS mapping
  "tts-1": "fmtts", // Keep as is if this works for your use case
}

export function getRuntimeKey() {
  const global = globalThis as typeof globalThis & Record<string, undefined | Any>
  if (global?.Deno !== undefined) {
    return "deno"
  }
  if (global?.Bun !== undefined) {
    return "bun"
  }
  if (typeof global?.WebSocketPair === "function") {
    return "workerd"
  }
  if (typeof global?.EdgeRuntime === "string") {
    return "edge-light"
  }
  if (global?.fastly !== undefined) {
    return "fastly"
  }
  if (global?.process?.release?.name === "node") {
    return "node"
  }
  return "other"
}
