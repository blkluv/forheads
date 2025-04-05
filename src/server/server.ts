import * as schema from "./db/schema";
import { typeIdGenerator, type UserId } from "./db/typeid";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, asc, and, desc } from "drizzle-orm";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { logger } from "hono/logger";
import { Hono } from "hono";
import { SelectMessageSchema, MessageSchema } from "./db/chat/chat.zod";
import { createDb } from "./db/db";
import { serverEnv } from "./serverEnv";
import { type Message, createDataStream } from "ai";
import { stream } from "hono/streaming";
import { createGameAgent } from "./ai/gameAgent";
import { createDrizzleChatHistoryService } from "./ai/chatHistoryService";
import { createAiClient } from "./ai/aiClient";
import { LiteralClient } from "@literalai/client";
import { isAddress } from "viem";
import { handlePicLevel } from "./ai/agentTools";

const db = createDb({
  logger: {
    logQuery: (query) => console.log(query),
  },
  dbUrl: serverEnv.DATABASE_URL,
});

const literalaiClient = new LiteralClient({
  apiKey: serverEnv.LITERAL_API_KEY,
});

// Create the Hono app
export const app = new Hono()
  .use(requestId())
  .use(logger())
  .use(
    "*",
    cors({
      origin: ["http://localhost:3000", "https://forheads.ai"],
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["POST", "GET", "OPTIONS", "PUT", "DELETE", "PATCH"],
      exposeHeaders: ["Content-Length"],
      maxAge: 600,
      credentials: true,
    }),
  )
  .get(
    "/conversation",
    zValidator("query", z.object({ address: z.string() })),
    async (c) => {
      const address = c.req.valid("query").address;
      if (!address) {
        return c.json({ error: "Address is required" }, 400);
      }
      const userId = await getUserIdFromContext(address);

      try {
        let conversation = await db.query.conversationsTable.findFirst({
          where: eq(schema.conversationsTable.createdBy, userId),
          columns: { id: true },
        });

        // If no conversation exists, create one and add the initial AI message
        if (!conversation) {
          const newConversationId = typeIdGenerator("conversation");
          try {
            const insertedConversation = await db
              .insert(schema.conversationsTable)
              .values({
                id: newConversationId,
                createdBy: userId,
                title: "New Conversation", // Add required title field
              })
              .returning({ id: schema.conversationsTable.id });

            if (insertedConversation.length === 0 || !insertedConversation[0]) {
              console.error(
                "Failed to create a new conversation for user:",
                userId,
              );
              return c.json(
                { error: "Failed to initialize conversation" },
                500,
              );
            }
            conversation = insertedConversation[0];

            const firstMessageId = typeIdGenerator("message");
            // Insert the initial AI message
            const firstMessageContent = {
              id: firstMessageId,
              role: "assistant",
              content: "Who are you?",
            } satisfies Message;
            const insertedMessage = await db
              .insert(schema.messagesTable)
              .values({
                id: firstMessageId,
                conversationId: conversation.id,
                message: firstMessageContent, // Use the correct schema {role, content}
                createdBy: userId,
              })
              .returning();

            if (insertedMessage.length === 0 || !insertedMessage[0]) {
              console.error(
                "Failed to insert initial AI message for conversation:",
                conversation.id,
              );
              // Potentially delete the conversation here or handle differently?
              return c.json(
                { error: "Failed to initialize conversation message" },
                500,
              );
            }

            const validatedFirstMessage = SelectMessageSchema.safeParse(
              insertedMessage[0],
            );
            if (!validatedFirstMessage.success) {
              console.error(
                "Failed to validate initial AI message:",
                validatedFirstMessage.error,
              );
              return c.json(
                { error: "Internal server error validating initial message" },
                500,
              );
            }
            // Return the first message in an array
            return c.json([validatedFirstMessage.data]);
          } catch (convError) {
            console.error(
              "Error during conversation/initial message creation:",
              convError,
            );
            return c.json({ error: "Failed to initialize conversation" }, 500);
          }
        }

        const messagesList = await db.query.messagesTable.findMany({
          where: eq(schema.messagesTable.conversationId, conversation.id),
          orderBy: [asc(schema.messagesTable.createdAt)],
        });

        const validatedMessages = z
          .array(SelectMessageSchema)
          .safeParse(messagesList);
        if (!validatedMessages.success) {
          console.error(
            "Failed to validate messages from DB:",
            validatedMessages.error,
          );
          return c.json(
            { error: "Internal server error validating data" },
            500,
          );
        }

        return c.json(validatedMessages.data);
      } catch (error) {
        console.error("Error fetching messages:", error);
        return c.json({ error: "Failed to fetch messages" }, 500);
      }
    },
  )

  // Send a new message
  .post(
    "/conversation",
    zValidator(
      "json",
      // Use a union to accept either { message: ... } or { messages: [...] }
      z.union([
        z.object({ message: MessageSchema, address: z.string() }),
        z.object({ messages: z.array(MessageSchema), address: z.string() }),
      ]),
    ),
    async (c) => {
      const data = c.req.valid("json");
      const address = data.address;

      // Extract the last message, adapting to the input format
      const userMessage =
        "messages" in data
          ? data.messages[data.messages.length - 1]
          : data.message;
      if (!userMessage) {
        return c.json({ error: "No message found in payload" }, 400);
      }

      console.log("Processing message:", userMessage);
      console.log("From address:", address);

      try {
        const userId = await getUserIdFromContext(address);

        // Ensure user exists (idempotent check/creation)
        await db
          .insert(schema.usersTable)
          .values({ id: userId, walletAddress: address })
          .onConflictDoNothing();

        // Find the user's conversation
        const conversation = await db.query.conversationsTable.findFirst({
          where: eq(schema.conversationsTable.createdBy, userId),
          columns: { id: true },
        });

        if (!conversation) {
          console.error("Conversation not found for user:", userId);
          return c.json({ error: "Conversation not found" }, 404);
        }

        const aiClient = createAiClient({
          providerConfigs: {
            googleGeminiApiKey: serverEnv.GOOGLE_GEMINI_API_KEY,
          },
        });

        // Initialize Game Agent (can be done once outside if stateless)
        const gameAgent = createGameAgent({ deps: { aiClient, db }, userId });

        // Create chat history service instance for this request
        const chatHistoryService = createDrizzleChatHistoryService({
          db,
          conversationId: conversation.id,
          userId,
        });

        // Start streaming response
        const dataStream = createDataStream({
          execute: async (dataStreamWriter) => {
            await literalaiClient
              .thread({ name: `Conversation ${conversation.id}`, id: userId }) // Use userId as thread ID
              .wrap(async () => {
                // Log the user message as a step
                await literalaiClient
                  .step({
                    type: "user_message",
                    name: "User",
                    input: { content: userMessage.content }, // Log input here
                  })
                  .send();

                // Create a step for the agent processing
                const agentStep = literalaiClient.step({
                  type: "llm", // Or 'agent' if more appropriate
                  name: "GameAgent Stream",
                  input: { content: userMessage.content }, // Agent input is user message
                });

                try {
                  // Process with agent within the Literal AI step context
                  const dataAgentStream = await gameAgent.queryStream({
                    dataStreamWriter,
                    message: userMessage,
                    chatHistoryService,
                  });
                  dataAgentStream.mergeIntoDataStream(dataStreamWriter);

                  // Mark the agent step as complete (output might be harder to capture directly with streams)
                  // You might need a way to capture the final streamed output if needed for Literal AI logging.
                  // For now, we just mark it sent. We could potentially log the stream status or final message ID.
                  await agentStep.send();
                } catch (agentError) {
                  console.error(
                    "Error during game agent execution:",
                    agentError,
                  );
                  // Log error to Literal AI step
                  await agentStep.send();
                  // Re-throw error to be caught by the outer handler if necessary
                  throw agentError;
                }
              });
          },
          onError: (error) => {
            console.error("Streaming error", error);
            // Optionally log error to Literal AI here as well, though the step error handling might cover it.
            return error instanceof Error ? error.message : String(error);
          },
        });

        // Mark the response as a v1 data stream
        c.header("X-Vercel-AI-Data-Stream", "v1");
        c.header("Content-Type", "text/plain; charset=utf-8");

        return stream(c, (stream) => stream.pipe(dataStream));
      } catch (error) {
        console.error("Error processing message:", error);
        // Consider logging the overall error to Literal AI if not caught within the thread wrap
        return c.json({ error: "Failed to process message" }, 500);
      }
    },
  )


  // get progression data for a user
  .get(
    "/progression",
    zValidator("query", z.object({ address: z.string(), level: schema.Level })),
    async (c) => {
      const address = c.req.valid("query").address;
      const level = c.req.valid("query").level;
      const userId = await getUserIdFromContext(address);

      // Fetch specific level progression data
      const progressionData = await db.query.levelProgressionTable.findMany({
        where: and(
          eq(schema.levelProgressionTable.userId, userId),
          eq(schema.levelProgressionTable.level, level),
        ),
         // Optionally add ordering if multiple entries per level are possible
        orderBy: [desc(schema.levelProgressionTable.createdAt)],
      });


      // Return the specific progression data found for that level
      // If you only expect one entry per level, you might use findFirst
      return c.json(progressionData);
    },
  )

  // get NFT metadata for an address
  .get(
    "/nft-metadata",
    zValidator("query", z.object({ address: z.string() })),
    async (c) => {
      const address = c.req.valid("query").address;
      const userId = await getUserIdFromContext(address);

      // Fetch all level progression entries for the user, sorted by latest first
      const levelProgressionEntries = await db.query.levelProgressionTable.findMany({
          where: eq(schema.levelProgressionTable.userId, userId),
          orderBy: [desc(schema.levelProgressionTable.createdAt)], // Sort descending
      });

      let latestImage: string | null = null;
      let latestCharacterSheet: schema.CharacterSchema | null = null;
      let latestSummary: string | null = null;
      let highestLevel: schema.Level | null = null;
      // Define level order for potential future use if needed
      // const levelOrder = schema.LEVELS;

      // Find the latest relevant data by iterating through sorted entries
      for (const entry of levelProgressionEntries) {
          // Find latest image from level1-picture
          if (!latestImage && entry.level === "level1-picture") {
              const parsedData = schema.Level1PictureSchema.safeParse(entry.data);
              if (parsedData.success) {
                  latestImage = parsedData.data.image;
              }
          }

          // Find latest character sheet from sheet, level1, or level2
          if (!latestCharacterSheet) {
              let parsedSheetData = null;
              if (entry.level === "level1-sheet") {
                  parsedSheetData = schema.Level1SheetSchema.safeParse(entry.data);
              } else if (entry.level === "level1") {
                  parsedSheetData = schema.Level1Schema.safeParse(entry.data);
              } else if (entry.level === "level2") {
                   parsedSheetData = schema.Level2Schema.safeParse(entry.data);
              }

              if (parsedSheetData?.success && 'characterSheet' in parsedSheetData.data) {
                   latestCharacterSheet = parsedSheetData.data.characterSheet;
              }
          }

          // Find latest summary from level1 or level2
          if (!latestSummary) {
              if (entry.level === "level1") {
                   const parsedData = schema.Level1Schema.safeParse(entry.data);
                   if (parsedData.success) latestSummary = parsedData.data.level1Summary;
              } else if (entry.level === "level2") {
                   const parsedData = schema.Level2Schema.safeParse(entry.data);
                   if (parsedData.success) latestSummary = parsedData.data.level2Summary;
              }
          }

          // Determine the highest level based on the first entry encountered (due to sorting)
           if (highestLevel === null && entry.level) {
              highestLevel = entry.level;
          }


          // Optimization: if we found the latest of each relevant piece, stop iterating
          // Note: We check highestLevel last as it's determined by the very first entry
          if (latestImage && latestCharacterSheet && latestSummary && highestLevel) {
              break;
          }
      }


      // --- Construct OpenSea Metadata ---
      const nftMetadata: {
          name: string;
          description: string;
          image?: string;
          external_url?: string; // Optional: Add later if needed
          attributes: { trait_type: string; value: string | number; display_type?: string }[];
      } = {
          name: "My Forehead Character", // Default name
          description: "A unique character generated through AI interaction in the Foreheads game.", // Default description
          attributes: [],
      };

      // Set image if found
      if (latestImage) {
          // Assuming PNG format for the base64 image from Level1PictureSchema
          nftMetadata.image = `data:image/png;base64,${latestImage}`;
      } else {
          // Optional: Provide a default placeholder image URL
          // nftMetadata.image = "https://example.com/placeholder.png";
      }

      // Populate details from the character sheet if found
      if (latestCharacterSheet) {
          const char = latestCharacterSheet.character;
          const attrs = latestCharacterSheet.attributes;
          const status = latestCharacterSheet.status;
          const profs = latestCharacterSheet.proficiencies;

          nftMetadata.name = char.name || nftMetadata.name; // Use character name if available
          nftMetadata.description = char.background || nftMetadata.description; // Use background if available
           if (latestSummary) {
              // Append summary, use Markdown newline
              nftMetadata.description += `\n\nLatest Progress: ${latestSummary}`;
          }

          // --- Add Attributes ---

          // Basic Info
          if (char.race) nftMetadata.attributes.push({ trait_type: "Race", value: char.race });
          if (char.class) nftMetadata.attributes.push({ trait_type: "Class", value: char.class });
          if (char.level !== undefined) nftMetadata.attributes.push({ trait_type: "Level", value: char.level, display_type: "number" });
          if (char.alignment) nftMetadata.attributes.push({ trait_type: "Alignment", value: char.alignment });

          // Core Attributes
          if (attrs.strength !== undefined) nftMetadata.attributes.push({ trait_type: "Strength", value: attrs.strength, display_type: "number" });
          if (attrs.dexterity !== undefined) nftMetadata.attributes.push({ trait_type: "Dexterity", value: attrs.dexterity, display_type: "number" });
          if (attrs.constitution !== undefined) nftMetadata.attributes.push({ trait_type: "Constitution", value: attrs.constitution, display_type: "number" });
          if (attrs.intelligence !== undefined) nftMetadata.attributes.push({ trait_type: "Intelligence", value: attrs.intelligence, display_type: "number" });
          if (attrs.wisdom !== undefined) nftMetadata.attributes.push({ trait_type: "Wisdom", value: attrs.wisdom, display_type: "number" });
          if (attrs.charisma !== undefined) nftMetadata.attributes.push({ trait_type: "Charisma", value: attrs.charisma, display_type: "number" });

          // Status (only include if not null/undefined)
          if (status.max_hp !== null && status.max_hp !== undefined) nftMetadata.attributes.push({ trait_type: "Max HP", value: status.max_hp, display_type: "number" });
          if (status.armor_class !== null && status.armor_class !== undefined) nftMetadata.attributes.push({ trait_type: "Armor Class", value: status.armor_class, display_type: "number" });
          if (status.speed !== null && status.speed !== undefined) nftMetadata.attributes.push({ trait_type: "Speed", value: status.speed, display_type: "number" });

           // Proficiencies (combine into strings for simplicity or list individually)
           if (profs.skills && profs.skills.length > 0) {
              nftMetadata.attributes.push({ trait_type: "Skills", value: profs.skills.join(', ') });
           }
           if (profs.languages && profs.languages.length > 0) {
              nftMetadata.attributes.push({ trait_type: "Languages", value: profs.languages.join(', ') });
           }
            // Consider adding weapons, armor, tools similarly if desired
      }

       // Add highest completed level/stage as a trait
       if (highestLevel) {
         // Map internal level name to a more user-friendly name
         const levelNameMap: Partial<Record<schema.Level, string>> = {
             "level1-picture": "Stage 1: Picture",
             "level1-sheet": "Stage 2: Sheet",
             "level1": "Stage 3: Level 1 Summary",
             "level2": "Stage 4: Level 2 Summary",
         };
         nftMetadata.attributes.push({ trait_type: "Highest Stage Reached", value: levelNameMap[highestLevel] || highestLevel });
       }

      return c.json(nftMetadata);
    },
  )

  // Add the test endpoint back
  .get(
    "/test-handle-pic",
    zValidator("query", z.object({ address: z.string().refine(isAddress, "Invalid address format") })),
    async (c) => {
      const address = c.req.valid("query").address;
      console.log(`[Test Endpoint] Testing handlePicLevel for address: ${address}`);

      try {
        const userId = await getUserIdFromContext(address);

        // Ensure user exists (or create if not)
        await db
          .insert(schema.usersTable)
          .values({ id: userId, walletAddress: address })
          .onConflictDoNothing();

        // Create necessary dependencies for handlePicLevel
        const aiClient = createAiClient({
          providerConfigs: {
            googleGeminiApiKey: serverEnv.GOOGLE_GEMINI_API_KEY,
          },
        });

        // Define a sample prompt for testing
        const testPrompt = "Generate a picture of a fairy cat with a pink background and unicorn horns and wings";

        // Call handlePicLevel
        const result = await handlePicLevel({
          userId,
          aiClient,
          db,
          prompt: testPrompt,
        });

        console.log("[Test Endpoint] handlePicLevel result:", result);

        // Return the result
        return c.json(result);

      } catch (error) {
        console.error("[Test Endpoint] Error calling handlePicLevel:", error);
        return c.json({ error: "Failed to execute handlePicLevel test" }, 500);
      }
    },
  )

export type AppType = typeof app;

async function getUserIdFromContext(address: string): Promise<UserId> {
  // check create user with wallet address
  const existingUser = await db.query.usersTable.findFirst({
    where: eq(schema.usersTable.walletAddress, address),
  });
  if (!existingUser) {
    const userId = typeIdGenerator("user");
    // Just create the basic user record
    await db
      .insert(schema.usersTable)
      .values({ 
          id: userId, 
          walletAddress: address, 
      });
    console.log(`Created new user ${userId} for address ${address}.`);
    return userId;
  }
  console.log(`Found existing user ${existingUser.id} for address ${address}.`);
  return existingUser.id;
}
