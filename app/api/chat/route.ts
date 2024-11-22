import { NextResponse } from 'next/server';
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Type definitions for better type safety
interface AudioMessage {
  id: string;
  expires_at?: number;
  transcript?: string;
}

interface Message {
  role: "user" | "assistant";
  content?: string | Array<{ type: string; text?: string; input_audio?: { data: string; format: string; } }>;
  audio?: AudioMessage;
}

export async function POST(req: Request) {
  const formData = await req.formData();
  console.log('formData:',formData);
  const audioFile = formData.get('audio') as File;
  const historyString = formData.get('history') as string;
  const history: Message[] = historyString ? JSON.parse(historyString) : [];

  try {
    let messages: Message[] = [];

    if (audioFile) {
      // Handle audio input
      const buffer = Buffer.from(await audioFile.arrayBuffer());
      
      // Add the new audio message to the conversation
      const newAudioMessage: Message = {
        role: "user",
        content: [
          { 
            type: "text", 
            text: "You are AI avatar of my child. Please help remember what I say and help me trigger more memory." 
          },
          { 
            type: "input_audio", 
            input_audio: { 
              data: buffer.toString('base64'), 
              format: "wav" 
            } 
          }
        ]
      };

      messages = [...history, newAudioMessage];
    } else {
      // Handle text input
      const newMessage = formData.get('text') as string;
      if (!newMessage) {
        return NextResponse.json({ error: "No message provided" }, { status: 400 });
      }

      // Add the new text message to the conversation
      const newTextMessage: Message = {
        role: "user",
        content: newMessage
      };

      messages = [...history, newTextMessage];
    }
    console.log('messages after input:',messages);

    // Transform messages to ensure proper format for the API
    const transformedMessages = messages.map(message => {
      if (message.role === "assistant" && message.audio?.id) {
        // For assistant messages with audio, include both audio ID and transcript if available
        return {
          role: "assistant",
          audio: {
            id: message.audio.id
          }
        };
      } else if (message.role === "user" && Array.isArray(message.content)) {
        // For user messages with audio input
        return {
          role: "user",
          content: message.content
        };
      } else {
        // For regular text messages
        return {
          role: message.role,
          content: message.content
        };
      }
    });
    
    console.log('messages after input & transformed:',transformedMessages);
    // Make the API call
    const response = await openai.chat.completions.create({
      model: "gpt-4o-audio-preview",
      modalities: ["text", "audio"],
      audio: { voice: "alloy", format: "wav" },
      messages: transformedMessages
    });
    console.log('OpenAI response:', response.choices[0].message);
    // Process the response
    const assistantMessage: Message = {
      role: "assistant",
      content: response.choices[0].message.content,
      audio: response.choices[0].message.audio ? {
        id: response.choices[0].message.audio.id,
        expires_at: response.choices[0].message.audio.expires_at,
        transcript: response.choices[0].message.audio.transcript
      } : undefined
    };
    
    // Add the assistant's response to the history
    const updatedHistory = [...messages, assistantMessage];
    console.log('messages after response:',updatedHistory);
    // Return both the immediate response and the updated history

    return NextResponse.json({
      response: response,
      history: updatedHistory
    });

  } catch (error) {
    console.error("Error calling OpenAI API:", error);
    return NextResponse.json({ 
      error: "There was an error processing your request.",
      details: error.response?.data || error.message 
    }, { status: 500 });
  }
}