/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { type FunctionDeclaration, SchemaType } from "@google/generative-ai";
import { useEffect, useRef, useState, memo } from "react";
import vegaEmbed from "vega-embed";
import { useLiveAPIContext } from "../../contexts/LiveAPIContext";
import { ToolCall, LiveConfig } from "../../multimodal-live-types";
import { Tool } from "../../lib/mcp-client-manager";

// Convert MCP tool to Gemini function declaration
function convertToolToFunctionDeclaration(tool: Tool): FunctionDeclaration {
  if (!tool.inputSchema?.properties) {
    return {
      name: tool.name,
      description: tool.description || '',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {},
        required: []
      }
    };
  }

  return {
    name: tool.name,
    description: tool.description,
    parameters: {
      type: SchemaType.OBJECT,
      properties: Object.entries(tool.inputSchema.properties).reduce((acc, [key, prop]) => {
        if (prop.type === 'array' && prop.items) {
          acc[key] = {
            type: SchemaType.ARRAY,
            items: {
              type: prop.items.type === 'string' ? SchemaType.STRING : SchemaType.OBJECT
            },
            description: prop.description || `Parameter ${key} for ${tool.name}`
          };
        } else {
          acc[key] = {
            type: SchemaType.STRING,
            description: prop.description || `Parameter ${key} for ${tool.name}`
          };
        }
        return acc;
      }, {} as Record<string, any>),
      required: tool.inputSchema.required || []
    }
  };
}

function AltairComponent() {
  const [jsonString, setJSONString] = useState<string>("");
  const { client, setConfig } = useLiveAPIContext();
  const [mcpTools, setMcpTools] = useState<Tool[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const embedRef = useRef<HTMLDivElement>(null);

  // Connect to MCP server and get tools
  useEffect(() => {
    const ws = new WebSocket('ws://localhost:3001');
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('Connected to MCP server, requesting tools...');
      ws.send(JSON.stringify({ type: 'tools_list' }));
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    ws.onclose = () => {
      console.log('WebSocket connection closed');
    };

    ws.onmessage = (event) => {
      console.log('Received WebSocket message:', event.data);
      const data = JSON.parse(event.data);
      console.log('Parsed message data:', data);

      if (data.type === 'tools_list') {
        if (!Array.isArray(data.tools)) {
          console.error('Invalid tools data:', data);
          return;
        }
        console.log('Received MCP tools:', JSON.stringify(data.tools, null, 2));
        setMcpTools(data.tools);
      } else if (data.type === 'tool_response') {
        console.log('Received tool response:', data);
        client.sendToolResponse({
          functionResponses: [{
            response: data.response,
            id: data.id
          }]
        });
      } else if (data.type === 'error') {
        console.error('Received error from server:', data.error);
      }
    };

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [client]);

  // Update Gemini config when MCP tools are loaded
  useEffect(() => {
    console.log('mcpTools changed:', mcpTools);
    if (mcpTools.length === 0) {
      console.log('No MCP tools available yet');
      return;
    }

    // Take N-1 tools (where N is total number of tools)
    const selectedTools = mcpTools.slice(0, mcpTools.length - 1);
    console.log('Selected tools for conversion:', JSON.stringify(selectedTools, null, 2));

    // Convert selected tools into function declarations
    const functionDeclarations = selectedTools.map((tool: Tool) => {
      console.log('Converting tool:', tool.name);
      const declaration = convertToolToFunctionDeclaration(tool);
      console.log(`Converted tool ${tool.name}:`, JSON.stringify(declaration, null, 2));
      return declaration;
    });

    console.log('All function declarations:', JSON.stringify(functionDeclarations, null, 2));

    const config: LiveConfig = {
      model: "models/gemini-2.0-flash-exp",
      generationConfig: {
        responseModalities: "audio",
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
        },
      },
      systemInstruction: {
        parts: [
          {
            text: `You are my helpful assistant. You have access to these tools for reading, writing, listing, searching, and managing files and directories. When I ask about file operations, use these tools to help me. Use the tools intelligently. and avoid asking for additional information unless required, just make your best judgment based on the tools available. for example, you only have access to specific directories to make changes, so use the tools to find that out first and then make the changes. same goes for other tools like github tools. first check if a repo exists, then create repo or update repo or create pr. You dont need to follow exactly as I said, just use your best judgement.`,
          },
        ],
      },
      tools: [
        { googleSearch: {} },
        { functionDeclarations: functionDeclarations }
      ],
    };

    console.log('Final config being sent to Gemini:', {
      model: config.model,
      tools: config.tools,
      functionDeclarations: functionDeclarations
    });
    
    setConfig(config);
  }, [setConfig, mcpTools]);

  // Handle tool calls
  useEffect(() => {
    const onToolCall = (toolCall: ToolCall) => {
      console.log(`Received tool call from Gemini:`, toolCall);

      // Handle each function call
      toolCall.functionCalls.forEach((fc) => {
        // Find the corresponding MCP tool
        const mcpTool = mcpTools.find(tool => tool.name === fc.name);
        if (!mcpTool) {
          console.error(`Tool ${fc.name} not found in MCP tools`);
          client.sendToolResponse({
            functionResponses: [{
              response: { error: `Tool ${fc.name} not found` },
              id: fc.id
            }]
          });
          return;
        }

        // Convert Gemini args to MCP format
        const mcpRequest = {
          type: 'call_tool',
          toolName: mcpTool.name,
          serverName: mcpTool.serverName,
          args: fc.args,
          requestId: fc.id
        };

        console.log('Sending MCP tool request:', JSON.stringify(mcpRequest, null, 2));
        
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify(mcpRequest));
        } else {
          console.error('WebSocket is not open');
          client.sendToolResponse({
            functionResponses: [{
              response: { error: 'WebSocket connection is not available' },
              id: fc.id
            }]
          });
        }
      });
    };

    client.on("toolcall", onToolCall);
    return () => {
      client.off("toolcall", onToolCall);
    };
  }, [client, mcpTools]);

  useEffect(() => {
    if (embedRef.current && jsonString) {
      vegaEmbed(embedRef.current, JSON.parse(jsonString));
    }
  }, [embedRef, jsonString]);

  return <div className="vega-embed" ref={embedRef} />;
}

export const Altair = memo(AltairComponent);
