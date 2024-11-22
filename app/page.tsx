'use client';

import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Mic, MicOff, Loader2 } from 'lucide-react';

// Types
interface Message {
  id: string;
  text: string;
  sender: 'user' | 'assistant';
  audioId?: string;
  audioTranscript?: string;
}

interface AudioMessage {
  id: string;
  expires_at: number;
  transcript?: string;
  data: string;
}

export default function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([
    { id: 'initial-1', text: 'Hello! How are you doing today?', sender: 'assistant'},
  ]);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const audioChunksRef = useRef<Float32Array[]>([]);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const audioSourcesRef = useRef<AudioBufferSourceNode[]>([]);

  // Cleanup function for audio resources
  const cleanupAudioResources = () => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    audioChunksRef.current = [];
  };
  useEffect(() => {
    console.log('Messages updated:', messages)
  }, [messages])
  // Cleanup on component unmount
  useEffect(() => {
    return () => {
      cleanupAudioResources();
      if (audioContextRef.current?.state !== 'closed') {
        audioContextRef.current?.close();
      }
    };
  }, []);

  const generateUniqueId = () => {
    return `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  };

  const startRecording = async () => {
    try {
      cleanupAudioResources(); // Cleanup before starting new recording
      
      console.log('Requesting microphone access...');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      const source = audioContextRef.current.createMediaStreamSource(stream);

      const processor = audioContextRef.current.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const audioData = new Float32Array(inputData.length);
        audioData.set(inputData);
        
        if (audioData.length > 0) {
          audioChunksRef.current.push(audioData);
        }
      };

      source.connect(processor);
      processor.connect(audioContextRef.current.destination);

      setIsRecording(true);
    } catch (error) {
      console.error('Error starting recording:', error);
      cleanupAudioResources();
    }
  };

  const stopRecording = async () => {
    try {
      setIsRecording(false);
      await sendAudioMessage();
    } catch (error) {
      console.error('Error stopping recording:', error);
    } finally {
      cleanupAudioResources();
    }
  };

  const formatMessagesForAPI = (msgs: Message[]) => {
    return msgs.map(msg => ({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.text,
      audio: msg.audioId ? {
        id: msg.audioId,
        transcript: msg.audioTranscript,
      } : undefined
    }));
  };

  const sendAudioMessage = async () => {
    if (audioChunksRef.current.length === 0) {
      console.warn('No audio data captured');
      return;
    }

    try {
      const sampleRate = audioContextRef.current?.sampleRate || 44100;
      const audioBlob = encodeWAV(audioChunksRef.current, sampleRate);
      
      const tempUserMessage: Message = {
        id: generateUniqueId(),
        text: '🎤 Audio message sent',
        sender: 'user',
      };

      setMessages(prev => [...prev, tempUserMessage]);
      
      const formData = new FormData();
      formData.append('audio', audioBlob, 'audio.wav');
      formData.append('history', JSON.stringify(formatMessagesForAPI(messages)));
      
      setIsLoading(true);

      const response = await fetch('/api/chat', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status}`);
      }

      const data = await response.json();
      handleBotResponse(data);

    } catch (error) {
      console.error('Error sending audio message:', error);
      handleError('Sorry, there was an error processing your audio message.');
    } finally {
      setIsLoading(false);
      audioChunksRef.current = [];
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (inputMessage.trim() === '' || isLoading) return;

    const newUserMessage: Message = {
      id: generateUniqueId(),
      text: inputMessage,
      sender: 'user'
    };

    setMessages(prev => [...prev, newUserMessage]);
    setInputMessage('');
    setIsLoading(true);

    try {
      const formData = new FormData();
      formData.append('text', inputMessage);
      formData.append('history', JSON.stringify(formatMessagesForAPI(messages)));

      const response = await fetch('/api/chat', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status}`);
      }

      const data = await response.json();
      handleBotResponse(data);

    } catch (error) {
      console.error('Error calling API:', error);
      handleError('Sorry, there was an error processing your request.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleBotResponse = (data: any) => {
    if (!data?.response?.choices?.[0]?.message) {
      handleError('Invalid response from server');
      return;
    }

    const botResponse = data.response.choices[0].message;
    const newBotMessage: Message = {
      id: generateUniqueId(),
      text: botResponse.content || botResponse.audio?.transcript || '',
      sender: 'assistant',
      audioId: botResponse.audio?.id,
      audioTranscript: botResponse.audio?.transcript,
    };

    setMessages(prev => [...prev, newBotMessage]);

    if (botResponse.audio?.data) {
      playAudio(botResponse.audio.data);
    }
  };

  const handleError = (errorMessage: string) => {
    const errorMsg: Message = {
      id: generateUniqueId(),
      text: errorMessage,
      sender: 'assistant'
    };
    setMessages(prev => [...prev, errorMsg]);
  };

  const playAudio = async (audioData: string) => {
    try {
      if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }

      const binaryString = atob(audioData);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const audioBuffer = await audioContextRef.current.decodeAudioData(bytes.buffer);
      const source = audioContextRef.current.createBufferSource();
      
      // Clean up previous sources
      audioSourcesRef.current.forEach(oldSource => {
        try {
          oldSource.stop();
          oldSource.disconnect();
        } catch (e) {
          // Ignore errors from already stopped sources
        }
      });
      audioSourcesRef.current = [];

      source.buffer = audioBuffer;
      source.connect(audioContextRef.current.destination);
      audioSourcesRef.current.push(source);
      
      source.start(0);
      source.onended = () => {
        source.disconnect();
        audioSourcesRef.current = audioSourcesRef.current.filter(s => s !== source);
      };
    } catch (error) {
      console.error('Error playing audio:', error);
      handleError('Sorry, there was an error playing the audio.');
    }
  };

  const encodeWAV = (audioChunks: Float32Array[], sampleRate: number): Blob => {
    const totalLength = audioChunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const buffer = new ArrayBuffer(44 + totalLength * 2);
    const view = new DataView(buffer);

    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    // Write WAV header
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + totalLength * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, totalLength * 2, true);

    let offset = 44;
    for (const chunk of audioChunks) {
      for (let i = 0; i < chunk.length; i++) {
        const sample = Math.max(-1, Math.min(1, chunk[i]));
        const value = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        view.setInt16(offset, value, true);
        offset += 2;
      }
    }

    return new Blob([buffer], { type: 'audio/wav' });
  };

  return (
    <div className="flex flex-col h-screen max-w-md mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">Elderly Memory Museum</h1>
      <ScrollArea className="flex-grow mb-4 p-4 border rounded-md">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`mb-2 p-2 rounded-lg ${
              message.sender === 'user' ? 'bg-blue-100 ml-auto' : 'bg-gray-100'
            } max-w-[80%] break-words`}
          >
            {message.text}
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-center items-center">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        )}
      </ScrollArea>
      <form onSubmit={handleSendMessage} className="flex gap-2">
        <Input
          type="text"
          value={inputMessage}
          onChange={(e) => setInputMessage(e.target.value)}
          placeholder="Type your message..."
          className="flex-grow"
          disabled={isLoading}
        />
        <Button type="submit" disabled={isLoading}>
          Send
        </Button>
        
        <Button
          type="button"
          onClick={isRecording ? stopRecording : startRecording}
          variant="outline"
          disabled={isLoading}
        >
          {isRecording ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        </Button>
      </form>
    </div>
  );
}