import type { AixAPI_Model, AixAPIChatGenerate_Request, AixMessages_ChatMessage, AixParts_DocPart, AixTools_ToolDefinition, AixTools_ToolsPolicy } from '../../../api/aix.wiretypes';
import { GeminiWire_API_Generate_Content, GeminiWire_ContentParts, GeminiWire_Messages, GeminiWire_Safety } from '../../wiretypes/gemini.wiretypes';


// configuration
const hotFixImagePartsFirst = true;


export function aixToGeminiGenerateContent(model: AixAPI_Model, chatGenerate: AixAPIChatGenerate_Request, geminiSafetyThreshold: GeminiWire_Safety.HarmBlockThreshold, jsonOutput: boolean, _streaming: boolean): TRequest {

  // Note: the streaming setting is ignored as it only belongs in the path

  // System Instructions
  const systemInstruction: TRequest['systemInstruction'] = chatGenerate.systemMessage?.parts.length
    ? { parts: chatGenerate.systemMessage.parts.map(part => GeminiWire_ContentParts.TextPart(part.text)) }
    : undefined;

  // Chat Messages
  const contents: TRequest['contents'] = _toGeminiContents(chatGenerate.chatSequence);

  // Construct the request payload
  const payload: TRequest = {
    contents,
    tools: chatGenerate.tools && _toGeminiTools(chatGenerate.tools),
    toolConfig: chatGenerate.toolsPolicy && _toGeminiToolConfig(chatGenerate.toolsPolicy),
    safetySettings: _toGeminiSafetySettings(geminiSafetyThreshold),
    systemInstruction,
    generationConfig: {
      stopSequences: undefined, // (default, optional)
      responseMimeType: jsonOutput ? 'application/json' : undefined,
      responseSchema: undefined, // (default, optional) NOTE: for JSON output, we'd take the schema here
      candidateCount: undefined, // (default, optional)
      maxOutputTokens: model.maxTokens !== undefined ? model.maxTokens : undefined,
      temperature: model.temperature !== undefined ? model.temperature : undefined,
      topP: undefined, // (default, optional)
      topK: undefined, // (default, optional)
    },
  };

  // Preemptive error detection with server-side payload validation before sending it upstream
  const validated = GeminiWire_API_Generate_Content.Request_schema.safeParse(payload);
  if (!validated.success)
    throw new Error(`Invalid message sequence for Gemini models: ${validated.error.errors?.[0]?.message || validated.error.message || validated.error}`);

  return validated.data;
}

type TRequest = GeminiWire_API_Generate_Content.Request;


function _toGeminiContents(chatSequence: AixMessages_ChatMessage[]): GeminiWire_Messages.Content[] {
  return chatSequence.map(message => {
    const parts: GeminiWire_ContentParts.ContentPart[] = [];

    if (hotFixImagePartsFirst) {
      message.parts.sort((a, b) => {
        if (a.pt === 'inline_image' && b.pt !== 'inline_image') return -1;
        if (a.pt !== 'inline_image' && b.pt === 'inline_image') return 1;
        return 0;
      });
    }

    for (const part of message.parts) {
      switch (part.pt) {

        case 'text':
          parts.push(GeminiWire_ContentParts.TextPart(part.text));
          break;

        case 'inline_image':
          parts.push(GeminiWire_ContentParts.InlineDataPart(part.mimeType, part.base64));
          break;

        case 'doc':
          parts.push(_toApproximateGeminiDocPart(part));
          break;

        case 'meta_reply_to':
          parts.push(_toApproximateGeminiReplyTo(part.replyTo));
          break;

        case 'tool_call':
          switch (part.call.type) {
            case 'function_call':
              parts.push(GeminiWire_ContentParts.FunctionCallPart(part.call.name, part.call.args ?? undefined));
              break;
            case 'code_execution':
              if (part.call.language?.toLowerCase() !== 'python')
                console.warn('Gemini only supports Python code execution, but got:', part.call.language);
              parts.push(GeminiWire_ContentParts.ExecutableCodePart('PYTHON', part.call.code));
              break;
            default:
              throw new Error(`Unsupported tool call type in message: ${(part as any).call.type}`);
          }
          break;

        case 'tool_response':
          const toolErrorPrefix = part.error ? (typeof part.error === 'string' ? `[ERROR] ${part.error} - ` : '[ERROR] ') : '';
          switch (part.response.type) {
            case 'function_call':
              parts.push(GeminiWire_ContentParts.FunctionResponsePart(part.response._name || part.id, toolErrorPrefix + part.response.result));
              break;
            case 'code_execution':
              parts.push(GeminiWire_ContentParts.CodeExecutionResultPart(!part.error ? 'OUTCOME_OK' : 'OUTCOME_ERROR', toolErrorPrefix + part.response.result));
              break;
            default:
              throw new Error(`Unsupported part type in message: ${(part as any).pt}`);
          }
          break;

        default:
          throw new Error(`Unsupported part type in message: ${(part as any).pt}`);
      }
    }

    return {
      role: message.role === 'model' ? 'model' : 'user',
      parts,
    };
  });
}

function _toGeminiTools(itds: AixTools_ToolDefinition[]): NonNullable<TRequest['tools']> {
  const tools: TRequest['tools'] = [];

  itds.forEach(itd => {
    switch (itd.type) {

      // Note: we add each function call as a separate tool, however it could be possible to add
      // a single tool with multiple function calls - which one to choose?
      case 'function_call':
        const { name, description, input_schema } = itd.function_call;
        tools.push({
          functionDeclarations: [{
            name,
            description,
            parameters: { type: 'object', ...input_schema },
          }],
        });
        break;

      case 'code_execution':
        if (itd.variant !== 'gemini_auto_inline')
          throw new Error('Gemini only supports inline code execution');

        // throw if code execution is present more than once
        if (tools.some(tool => tool.codeExecution))
          throw new Error('Gemini code interpreter already defined');

        tools.push({ codeExecution: {} });
        break;

    }
  });

  return tools;
}

function _toGeminiToolConfig(itp: AixTools_ToolsPolicy): NonNullable<TRequest['toolConfig']> {
  switch (itp.type) {
    case 'auto':
      return { functionCallingConfig: { mode: 'AUTO' } };
    case 'any':
      return { functionCallingConfig: { mode: 'ANY' } };
    case 'function_call':
      return {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: [itp.function_call.name],
        },
      };
  }
}

function _toGeminiSafetySettings(threshold: GeminiWire_Safety.HarmBlockThreshold): TRequest['safetySettings'] {
  return threshold === 'HARM_BLOCK_THRESHOLD_UNSPECIFIED' ? undefined : [
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: threshold },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: threshold },
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: threshold },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: threshold },
  ];
}


// Approximate conversions - alternative approaches should be tried until we find the best one

function _toApproximateGeminiDocPart(aixPartsDocPart: AixParts_DocPart): GeminiWire_ContentParts.ContentPart {
  return GeminiWire_ContentParts.TextPart(`\`\`\`${aixPartsDocPart.ref || ''}\n${aixPartsDocPart.data.text}\n\`\`\`\n`);
}

function _toApproximateGeminiReplyTo(replyTo: string): GeminiWire_ContentParts.ContentPart {
  return GeminiWire_ContentParts.TextPart(`<context>The user is referring to this in particular: ${replyTo}</context>`);
}