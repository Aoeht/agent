// // src/tools/scamDetectorTool.ts
// import OpenAI from "openai";
// import { ToolDefinition } from "../core/types";
// // import { parseAndCleanSRT } from "../utils/srt_parser";

// const openai = new OpenAI();

// export const detectScamFromSrtTool: ToolDefinition = {
//   name: "detect_scam_from_srt",
//   description: "分析 SRT 字幕/语音转写文本是否对观众构成诈骗风险。能精准区分社区反讽、玩梗/日常聊天/新闻与真正诈骗。",
//   parameters: {
//     type: "object",
//     properties: {
//       srtContent: {
//         type: "string",
//         description: "SRT 文件完整文本"
//       }
//     },
//     required: ["srtContent"]
//   },

//   execute: async (args: unknown) => {
//     const { srtContent } = args as { srtContent: string };

//     const segments = parseAndCleanSRT(srtContent);
//     if (segments.length === 0) {
//       return {
//         hasScam: false,
//         summary: "未检测到有效对话文本（可能全为背景音或音乐）。",
//         evidenceList: []
//       };
//     }

//     // 格式化为：[00:00:01,190 -> 00:00:21,200] (说话人 1): 这款是Cber出品...
//   }
// };