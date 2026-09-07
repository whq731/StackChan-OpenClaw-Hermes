// Minimal ambient declarations for onnxruntime-node@1.20.1 (package ships no
// .d.ts on this install). Only the surface used by silero_vad.ts is declared.
declare module 'onnxruntime-node' {
    export declare class Tensor {
        constructor(type: 'float32' | 'int64', data: Float32Array | BigInt64Array, dims?: readonly number[])
        readonly type: string
        readonly data: Float32Array | BigInt64Array
        readonly dims: readonly number[]
    }

    export interface InferenceSession {
        readonly inputNames: readonly string[]
        readonly outputNames: readonly string[]
        run(feed: Record<string, Tensor>): Promise<Record<string, Tensor>>
    }

    export interface SessionOptions {
        graphOptimizationLevel?: string
    }

    export const InferenceSession: {
        create(path: string, options?: SessionOptions): Promise<InferenceSession>
    }
}
