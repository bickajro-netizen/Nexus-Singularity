// Shared repository contract types (ARCHITECTURE_BLUEPRINT_V2 § repositories).
// Populated as modules land; MediaBlobRecord is the canvas-module blob contract.
// 22.11 delta: ownerType +'exercise' (WorkoutPlayer demo blobs), +createdAt
// (latest-owner-wins resolution) — Lead-patched, workers consistent on both sides.

export interface MediaBlobRecord { id: string; mimeType: string; byteLength: number; sha256: string; blob: Blob; ownerType: 'user'|'quest'|'level'|'exercise'; ownerId: string; createdAt: number }
