import "dotenv/config";
import { GoogleGenAI, Modality } from "@google/genai";
import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_API_KEY = "AIzaSyCGzzB-12I9hRw6DJnghJl6wMVWGc1iTMQ";

const SOURCE_IMAGE = process.env.GENAI_SOURCE_IMAGE || "angelImage.jpg";

const resolveImagePath = () => {
  const absolute = path.resolve(SOURCE_IMAGE);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Image not found at ${absolute}`);
  }
  return absolute;
};

const main = async () => {
  const imagePath = resolveImagePath();
  const apiKey = process.env.GENAI_API_KEY || process.env.GOOGLE_GENAI_API_KEY || DEFAULT_API_KEY;

  const ai = new GoogleGenAI({ apiKey });

  const imageData = fs.readFileSync(imagePath);
  const base64Image = imageData.toString("base64");

  const prompt = [
    {
      text: "Using the provided image, please change the bulb from the top to something random original",
    },
    {
      inlineData: {
        mimeType: "image/png",
        data: base64Image,
      },
    },
  ];

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-image",
    contents: prompt,
    generationConfig: {
      responseMimeType: "image/png",
    },
  });

  console.log("Raw response:", JSON.stringify(response, null, 2));

  const candidate = response.candidates?.[0];
  if (!candidate) {
    throw new Error("No candidates returned from model.");
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const imagesDir = path.resolve("images");
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }
  const outputName =
    process.env.GENAI_OUTPUT_IMAGE ||
    path.join(imagesDir, `genai-${timestamp}.png`);
  const desiredModality = Modality.IMAGE;

  const parts = candidate.content?.parts ?? [];
  if (!parts.length) {
    console.warn(
      "No content parts returned. Finish reason:",
      candidate.finishReason,
      "Safety ratings:",
      candidate.safetyRatings
    );
  }

  for (const part of parts) {
    if (part.text) {
      console.log(part.text);
    } else if (
      part.inlineData &&
      (!part.modality || part.modality === desiredModality)
    ) {
      const buffer = Buffer.from(part.inlineData.data, "base64");
      fs.writeFileSync(outputName, buffer);
      console.log(`Image saved as ${outputName}`);
    }
  }
};

main().catch((error) => {
  console.error("GenAI demo failed:", error.message ?? error);
  process.exit(1);
});
