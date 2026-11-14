import { describe, expect, it } from "vitest";
import {
	buildSrt,
	buildTranscriptText,
	cleanWhisperCues,
	formatSrtTime,
	formatTranscriptClock,
	joinTranscriptText,
	parseWhisperProgress,
} from "./transcriptFiles";

describe("transcript files", () => {
	it("formats times", () => {
		expect(formatTranscriptClock(75_000)).toBe("01:15");
		expect(formatTranscriptClock(3_725_000)).toBe("1:02:05");
		expect(formatSrtTime(3_725_042)).toBe("01:02:05,042");
		expect(formatSrtTime(0)).toBe("00:00:00,000");
	});

	it("joins Chinese without spaces and English with them", () => {
		expect(joinTranscriptText("大家好。", "我们开始吧")).toBe("大家好。我们开始吧");
		expect(joinTranscriptText("Hello.", "Let's start")).toBe("Hello. Let's start");
		expect(joinTranscriptText("预算是", "5 million")).toBe("预算是 5 million");
	});

	it("drops silence markers and repeated lines", () => {
		const cues = cleanWhisperCues([
			{ startMs: 0, endMs: 2000, text: "[BLANK_AUDIO]" },
			{ startMs: 2000, endMs: 4000, text: " Thank you. " },
			{ startMs: 4000, endMs: 6000, text: "Thank you." },
			{ startMs: 6000, endMs: 8000, text: "(music)" },
			{ startMs: 8000, endMs: 9000, text: "♪ ♪" },
			{ startMs: 9000, endMs: 12000, text: "Let's start with the budget." },
		]);
		expect(cues).toEqual([
			{ startMs: 2000, endMs: 6000, text: "Thank you." },
			{ startMs: 9000, endMs: 12000, text: "Let's start with the budget." },
		]);
	});

	it("groups cues into timed paragraphs", () => {
		const text = buildTranscriptText([
			{ startMs: 1000, endMs: 4000, text: "Thanks for joining." },
			{ startMs: 4500, endMs: 8000, text: "First item is the solar project." },
			{ startMs: 75_000, endMs: 79_000, text: "Next, hiring." },
		]);
		expect(text).toBe(
			"[00:01] Thanks for joining. First item is the solar project.\n\n[01:15] Next, hiring.\n",
		);
	});

	it("writes a standard SRT", () => {
		expect(
			buildSrt([
				{ startMs: 0, endMs: 2500, text: "Hello." },
				{ startMs: 2500, endMs: 5000, text: "Hi." },
			]),
		).toBe(
			"1\n00:00:00,000 --> 00:00:02,500\nHello.\n\n2\n00:00:02,500 --> 00:00:05,000\nHi.\n",
		);
	});

	it("reads whisper progress lines", () => {
		expect(parseWhisperProgress("whisper_print_progress_callback: progress =  45%")).toBe(45);
		expect(parseWhisperProgress("operator(): progress = 100%")).toBe(100);
		expect(parseWhisperProgress("whisper_init_from_file: loading model")).toBeNull();
	});
});
