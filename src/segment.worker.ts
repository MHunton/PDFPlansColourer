import { segment, type SegmentInput } from "./segment";

self.onmessage = (e: MessageEvent<SegmentInput>) => postMessage(segment(e.data));
