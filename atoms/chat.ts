import { ChatWithMessageCountAndSettings, MessageT } from "@/types/collections";
import {
  ChatGPTMessage,
  OpenAIKeyOptional,
  OpenAIKeyRequired,
  OpenAISettings,
  OpenAIStreamPayload,
} from "@/types/openai";
import { atom } from "jotai";
import { createRef } from "react";
import { v4 as uuidv4 } from "uuid";

export const defaultSystemPropmt = `You are makr.AI, a large language model trained by OpenAI.`;

// To hold OpenAI API Key (Not Exported)
const openAIAPIKeyAtom = atom<string>("");

// To control OpenAI API Key (Set and Delete)
export const openAPIKeyHandlerAtom = atom(
  (get) => get(openAIAPIKeyAtom),
  (_get, set, payload: OpenAIKeyOptional | OpenAIKeyRequired) => {
    if (payload.action === "remove") {
      set(openAIAPIKeyAtom, "");
      localStorage.removeItem("openai-api-key");
    } else if (payload.action === "set") {
      set(openAIAPIKeyAtom, payload.key);
      localStorage.setItem("openai-api-key", payload.key);
    } else if (payload.action === "get") {
      // Check ENV first
      const localKey = localStorage.getItem("openai-api-key");
      if (localKey) {
        set(openAIAPIKeyAtom, localKey);
      }
    }
  }
);

// To control OpenAI Settings when starting new chat (New Chat Component)
export const openAISettingsAtom = atom<OpenAISettings>({
  model: "gpt-3.5-turbo",
  system_prompt: defaultSystemPropmt,
  advanced_settings: {
    temperature: 0.7,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
    max_tokens: 1000,
    stream: true,
    n: 1,
  },
});

// To combine all settings and messages in a state for sending new message (Read Only)
const openAIPayload = atom<OpenAIStreamPayload>((get) => {
  const currentChat = get(currentChatAtom);
  return {
    apiKey: get(openAIAPIKeyAtom),
    model: currentChat?.model ?? "gpt-3.5-turbo",
    messages: [
      {
        content:
          currentChat?.system_prompt!! +
          `Answer as concisely as possible and ALWAYS answer in MARKDOWN. Current date: ${new Date()}`,
        role: "system",
      },
      ...get(messagesAtom).map(
        (m) =>
          ({
            content: m.content as string,
            role: m.role ?? "user",
          } as ChatGPTMessage)
      ),
    ],
    ...currentChat?.advanced_settings!!,
  };
});

// To control handling state of add message logic
const handlingAtom = atom<boolean>(false);
// Chatbox Ref for controlling scroll
export const chatboxRefAtom = atom(createRef<HTMLDivElement>());
// Chat Input
export const inputAtom = atom<string>("");

// Where we keep current chat ID - (Read Only)
export const chatIDAtom = atom<string>((get) => get(currentChatAtom)?.id ?? "");
// Where we keep current chat
export const currentChatAtom = atom<null | ChatWithMessageCountAndSettings>(
  null
);
export const chatsAtom = atom<ChatWithMessageCountAndSettings[]>([]);
// Where we keep all the messages
export const messagesAtom = atom<MessageT[]>([]);
// To check if chat has messages (Read Only)
export const currentChatHasMessagesAtom = atom<boolean>(
  (get) => get(messagesAtom).length > 0
);

// Abort Controller for OpenAI Stream
const abortControllerAtom = atom<AbortController>(new AbortController());
export const cancelHandlerAtom = atom(
  (get) => get(handlingAtom),
  (get, set) => {
    const abortController = get(abortControllerAtom);
    abortController.abort();
    set(handlingAtom, false);
    set(abortControllerAtom, new AbortController());
  }
);

// Add Message Handler
export const addMessageAtom = atom(
  (get) => get(handlingAtom),
  async (get, set, action: "generate" | "regenerate" = "generate") => {
    const inputValue = get(inputAtom);
    const isHandlig = get(handlingAtom);
    const chatID = get(chatIDAtom);
    const apiKey = get(openAIAPIKeyAtom);
    // Early Returns
    if (
      isHandlig ||
      (inputValue.length < 2 && action !== "regenerate") ||
      !apiKey
    ) {
      return;
    }

    // Build User's Message Object in Function Scope - We need to use it in multiple places
    const userMessage: MessageT = {
      content: inputValue,
      role: "user",
      chat: chatID!!,
      id: uuidv4(),
      created_at: String(new Date()),
      owner: "",
    };

    // Add to Supabase Handler
    const addMessagetoSupabase = async (messages: MessageT[]) => {
      try {
        // Add message to the Supabase
        const response = await fetch("/api/supabase/message", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messages,
          }),
        });
        if (!response.ok) throw new Error("Failed to add message to Supabase");
        return await response.json();
      } catch (error) {
        console.log(error);
      }
    };

    // Scroll Down Handler
    const scrollDown = () => {
      const chatboxRef = get(chatboxRefAtom);
      if (chatboxRef.current) {
        chatboxRef.current.scrollTop = chatboxRef.current.scrollHeight;
      }
    };

    // Start Handling
    set(handlingAtom, true);

    /* 1) Add User Message to the State */
    if (action === "generate") {
      set(messagesAtom, (prev) => {
        return [...prev, userMessage];
      });

      // Clear Input
      set(inputAtom, "");

      // Scroll down after insert
      scrollDown();
    }

    /* 2) Send Messages to the API to get response from OpenAI */
    const initialID = uuidv4();
    // Set Initial Message to the State (We need show "thinking" message to the user before we get response")
    set(messagesAtom, (prev) => {
      return [
        ...prev,
        {
          id: initialID,
          content: "",
          role: "assistant",
          created_at: String(new Date()),
          chat: chatID!!,
          owner: "",
        },
      ];
    });

    // Scroll down after insert
    scrollDown();

    // Response Fetcher and Stream Handler
    try {
      const response = await fetch("/api/openai/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          payload: get(openAIPayload),
        }),
        signal: get(abortControllerAtom).signal,
      });

      if (!response.ok) {
        throw new Error(response.statusText);
      }

      // This data is a ReadableStream
      const data = response.body;
      if (!data) {
        throw new Error("No data from response.");
      }

      const reader = data.getReader();
      const decoder = new TextDecoder();
      let done = false;

      while (!done) {
        const { value, done: doneReading } = await reader.read();
        done = doneReading;
        const chunkValue = decoder.decode(value);
        set(messagesAtom, (prev) => {
          const responseMessage = prev.find((m) => m.id === initialID);
          if (!responseMessage) {
            console.log("No response message", responseMessage);
            return prev;
          }
          return [
            ...prev.filter((m) => m.id !== initialID),
            {
              ...responseMessage,
              content: responseMessage?.content + chunkValue,
            },
          ];
        });

        /* Scroll to the bottom as we get chunk */
        scrollDown();
      }
    } catch (error) {
      console.log(error);
      // Set Error Message into the State
      set(messagesAtom, (prev) => {
        const responseMessage = prev.find((m) => m.id === initialID);
        if (!responseMessage) {
          console.log("No response message", responseMessage);
          return prev;
        }
        return [
          ...prev.filter((m) => m.id !== initialID),
          {
            ...responseMessage,
            content: "Oops! Something went wrong. Please try again.",
          },
        ];
      });
    } finally {
      // Stop Handling
      set(handlingAtom, false);
      // Add messages to the Supabase if exists
      const finalAIMessage = get(messagesAtom).find(
        (m) => m.id === initialID
      ) as MessageT;
      if (action === "generate") {
        const instertedMessages = await addMessagetoSupabase(
          finalAIMessage ? [userMessage, finalAIMessage] : [userMessage]
        );

        for (const message of instertedMessages) {
          if (message.role === "user") {
            set(messagesAtom, (prev) => {
              return prev.map((m) => {
                if (m.id === userMessage.id) {
                  return {
                    ...m,
                    id: message.id,
                  };
                }
                return m;
              });
            });
          } else {
            set(messagesAtom, (prev) => {
              return prev.map((m) => {
                if (m.id === initialID) {
                  return {
                    ...m,
                    id: message.id,
                  };
                }
                return m;
              });
            });
          }
        }
      }
      // Regenerate
      else {
        const instertedMessages = await addMessagetoSupabase([finalAIMessage!]);
        // Change the dummy IDs with the real ones
        if (!instertedMessages) {
          console.log("No inserted messages found");
          return;
        }
        set(messagesAtom, (prev) => {
          return prev.map((m) => {
            if (m.id === initialID) {
              return {
                ...m,
                id: instertedMessages[0].id,
              };
            }
            return m;
          });
        });
      }
    }

    /* 3) Change Conversation Title */
    if (action === "generate") {
      try {
        // If chat is new, update the chat title
        const isChatNew = get(messagesAtom).length === 2;
        if (isChatNew) {
          const response = await fetch("/api/openai/chat-title", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messages: get(messagesAtom).map((message) => {
                return {
                  content: message.content,
                  role: message.role,
                };
              }),
              chatID: get(chatIDAtom),
              apiKey: get(openAIAPIKeyAtom),
            }),
          });
          const { title } = await response.json();
          if (title) {
            set(chatsAtom, (prev) => {
              return prev.map((c) => {
                if (c.id === get(chatIDAtom)) {
                  return {
                    ...c,
                    title,
                  };
                }
                return c;
              });
            });
          }
        }
      } catch (error) {
        console.log(error);
      }
    }
  }
);

// Re-generate Handler
export const regenerateHandlerAtom = atom(
  (get) => {
    // Is there any message from the assistant?
    const assistantMessage =
      get(messagesAtom).filter((m) => m.role === "assistant")?.length > 0;
    const isHandling = get(handlingAtom);
    return Boolean(assistantMessage && !isHandling);
  },
  async (get, set) => {
    // Remove last assistant message
    const allMessages = [...get(messagesAtom)];
    const lastMessage = allMessages.pop();

    if (lastMessage?.role === "assistant") {
      set(messagesAtom, allMessages);
      // Remove from Supabase
      await fetch("/api/supabase/message", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: lastMessage,
        }),
      });

      await set(addMessageAtom, "regenerate");
    }
  }
);
