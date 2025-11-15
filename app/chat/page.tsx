'use client';

import { useChat } from '@ai-sdk/react';
import { useState } from 'react';
import { motion } from 'motion/react';
import { Send, Bot, User, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

export default function ChatPage() {
  const [input, setInput] = useState('');
  const { messages, sendMessage, isLoading } = useChat();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    
    sendMessage({ text: input });
    setInput('');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/20">
      <div className="container mx-auto px-4 py-8 h-screen flex flex-col max-w-4xl">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6"
        >
          <Card className="border-primary/20">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bot className="w-5 h-5 text-primary" />
                AI Chat Assistant
                <Badge variant="secondary" className="ml-auto">
                  Gemini 2.5 Flash
                </Badge>
              </CardTitle>
            </CardHeader>
          </Card>
        </motion.div>

        {/* Messages */}
        <ScrollArea className="flex-1 mb-4 rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm">
          <div className="p-4 space-y-4">
            {messages.length === 0 ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-center text-muted-foreground py-12"
              >
                <Bot className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p className="text-lg">Start a conversation with the AI assistant</p>
                <p className="text-sm mt-2">
                  Ask questions, get help, or just chat!
                </p>
              </motion.div>
            ) : (
              messages.map((message) => (
                <motion.div
                  key={message.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`flex gap-3 ${
                    message.role === 'user' ? 'justify-end' : 'justify-start'
                  }`}
                >
                  {message.role === 'assistant' && (
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                      <Bot className="w-4 h-4 text-primary" />
                    </div>
                  )}
                  
                  <Card
                    className={`max-w-[80%] ${
                      message.role === 'user'
                        ? 'bg-primary/10 border-primary/20'
                        : 'bg-card'
                    }`}
                  >
                    <CardContent className="p-4">
                      <div className="space-y-2">
                        {message.parts.map((part, i) => {
                          switch (part.type) {
                            case 'text':
                              return (
                                <div
                                  key={`${message.id}-${i}`}
                                  className="whitespace-pre-wrap text-sm leading-relaxed"
                                >
                                  {part.text}
                                </div>
                              );
                            default:
                              // Handle tool calls and other part types
                              return (
                                <div
                                  key={`${message.id}-${i}`}
                                  className="text-xs text-muted-foreground font-mono bg-muted/50 p-2 rounded"
                                >
                                  {JSON.stringify(part, null, 2)}
                                </div>
                              );
                          }
                        })}
                      </div>
                    </CardContent>
                  </Card>

                  {message.role === 'user' && (
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                      <User className="w-4 h-4 text-primary" />
                    </div>
                  )}
                </motion.div>
              ))
            )}
            
            {isLoading && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex gap-3 justify-start"
              >
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                  <Bot className="w-4 h-4 text-primary" />
                </div>
                <Card className="bg-card">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin text-primary" />
                      <span className="text-sm text-muted-foreground">
                        Thinking...
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            )}
          </div>
        </ScrollArea>

        {/* Input Form */}
        <motion.form
          onSubmit={handleSubmit}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex gap-2"
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type your message..."
            disabled={isLoading}
            className="flex-1"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
          />
          <Button
            type="submit"
            disabled={!input.trim() || isLoading}
            size="icon"
            className="shrink-0"
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </Button>
        </motion.form>
      </div>
    </div>
  );
}

