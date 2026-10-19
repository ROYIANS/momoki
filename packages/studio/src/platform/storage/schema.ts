import type {TableName} from "./tableTypes";

export interface IndexDefinition {
    readonly name: string;
    readonly keyPaths: readonly string[];
    readonly unique: boolean
}

export interface TableDefinition {
    readonly keyPath: string;
    readonly scope: "content" | "device" | "mixed";
    readonly indexes: readonly IndexDefinition[]
}

/** Closed current schema; schema.json is checked for exact parity by conformance tests. */
export const PRODUCT_SCHEMA = {
    "projects": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "kind",
                "keyPaths": [
                    "kind"
                ],
                "unique": false
            },
            {
                "name": "updatedAt",
                "keyPaths": [
                    "updatedAt"
                ],
                "unique": false
            }
        ]
    },
    "characters": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "updatedAt",
                "keyPaths": [
                    "updatedAt"
                ],
                "unique": false
            }
        ]
    },
    "scenes": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "updatedAt",
                "keyPaths": [
                    "updatedAt"
                ],
                "unique": false
            }
        ]
    },
    "shots": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "episodeId",
                "keyPaths": [
                    "episodeId"
                ],
                "unique": false
            },
            {
                "name": "order",
                "keyPaths": [
                    "order"
                ],
                "unique": false
            }
        ]
    },
    "media": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            }
        ]
    },
    "props": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "updatedAt",
                "keyPaths": [
                    "updatedAt"
                ],
                "unique": false
            }
        ]
    },
    "styles": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "updatedAt",
                "keyPaths": [
                    "updatedAt"
                ],
                "unique": false
            }
        ]
    },
    "episodes": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "order",
                "keyPaths": [
                    "order"
                ],
                "unique": false
            },
            {
                "name": "updatedAt",
                "keyPaths": [
                    "updatedAt"
                ],
                "unique": false
            }
        ]
    },
    "connectors": {
        "keyPath": "id",
        "scope": "device",
        "indexes": [
            {
                "name": "definitionId",
                "keyPaths": [
                    "definitionId"
                ],
                "unique": true
            },
            {
                "name": "updatedAt",
                "keyPaths": [
                    "updatedAt"
                ],
                "unique": false
            }
        ]
    },
    "chatThreads": {
        "keyPath": "id",
        "scope": "mixed",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "updatedAt",
                "keyPaths": [
                    "updatedAt"
                ],
                "unique": false
            }
        ]
    },
    "chatMessages": {
        "keyPath": "id",
        "scope": "mixed",
        "indexes": [
            {
                "name": "threadId",
                "keyPaths": [
                    "threadId"
                ],
                "unique": false
            },
            {
                "name": "createdAt",
                "keyPaths": [
                    "createdAt"
                ],
                "unique": false
            }
        ]
    },
    "productionProposals": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "episodeId",
                "keyPaths": [
                    "episodeId"
                ],
                "unique": false
            },
            {
                "name": "status",
                "keyPaths": [
                    "status"
                ],
                "unique": false
            },
            {
                "name": "createdAt",
                "keyPaths": [
                    "createdAt"
                ],
                "unique": false
            }
        ]
    },
    "agents": {
        "keyPath": "id",
        "scope": "mixed",
        "indexes": []
    },
    "agentRuns": {
        "keyPath": "id",
        "scope": "mixed",
        "indexes": [
            {
                "name": "threadId",
                "keyPaths": [
                    "threadId"
                ],
                "unique": false
            },
            {
                "name": "taskId",
                "keyPaths": [
                    "taskId"
                ],
                "unique": false
            },
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "status",
                "keyPaths": [
                    "status"
                ],
                "unique": false
            },
            {
                "name": "createdAt",
                "keyPaths": [
                    "createdAt"
                ],
                "unique": false
            }
        ]
    },
    "agentToolCalls": {
        "keyPath": "id",
        "scope": "mixed",
        "indexes": [
            {
                "name": "runId",
                "keyPaths": [
                    "runId"
                ],
                "unique": false
            },
            {
                "name": "threadId",
                "keyPaths": [
                    "threadId"
                ],
                "unique": false
            },
            {
                "name": "[runId+providerCallId]",
                "keyPaths": [
                    "runId",
                    "providerCallId"
                ],
                "unique": true
            },
            {
                "name": "status",
                "keyPaths": [
                    "status"
                ],
                "unique": false
            }
        ]
    },
    "agentTasks": {
        "keyPath": "id",
        "scope": "mixed",
        "indexes": [
            {
                "name": "threadId",
                "keyPaths": [
                    "threadId"
                ],
                "unique": true
            },
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "lifecycle",
                "keyPaths": [
                    "lifecycle"
                ],
                "unique": false
            },
            {
                "name": "updatedAt",
                "keyPaths": [
                    "updatedAt"
                ],
                "unique": false
            }
        ]
    },
    "contextCompactions": {
        "keyPath": "id",
        "scope": "mixed",
        "indexes": [
            {
                "name": "threadId",
                "keyPaths": [
                    "threadId"
                ],
                "unique": false
            },
            {
                "name": "runId",
                "keyPaths": [
                    "runId"
                ],
                "unique": false
            },
            {
                "name": "status",
                "keyPaths": [
                    "status"
                ],
                "unique": false
            },
            {
                "name": "createdAt",
                "keyPaths": [
                    "createdAt"
                ],
                "unique": false
            }
        ]
    },
    "agentGenerationJobs": {
        "keyPath": "id",
        "scope": "mixed",
        "indexes": [
            {
                "name": "callId",
                "keyPaths": [
                    "callId"
                ],
                "unique": true
            },
            {
                "name": "batchItemId",
                "keyPaths": [
                    "batchItemId"
                ],
                "unique": true
            },
            {
                "name": "batchId",
                "keyPaths": [
                    "batchId"
                ],
                "unique": false
            },
            {
                "name": "runId",
                "keyPaths": [
                    "runId"
                ],
                "unique": false
            },
            {
                "name": "threadId",
                "keyPaths": [
                    "threadId"
                ],
                "unique": false
            },
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "status",
                "keyPaths": [
                    "status"
                ],
                "unique": false
            },
            {
                "name": "fingerprint",
                "keyPaths": [
                    "fingerprint"
                ],
                "unique": false
            },
            {
                "name": "updatedAt",
                "keyPaths": [
                    "updatedAt"
                ],
                "unique": false
            }
        ]
    },
    "agentTaskRecords": {
        "keyPath": "id",
        "scope": "mixed",
        "indexes": [
            {
                "name": "taskId",
                "keyPaths": [
                    "taskId"
                ],
                "unique": false
            },
            {
                "name": "[taskId+kind]",
                "keyPaths": [
                    "taskId",
                    "kind"
                ],
                "unique": false
            },
            {
                "name": "updatedAt",
                "keyPaths": [
                    "updatedAt"
                ],
                "unique": false
            }
        ]
    },
    "agentTaskRecordVersions": {
        "keyPath": "versionId",
        "scope": "mixed",
        "indexes": [
            {
                "name": "taskId",
                "keyPaths": [
                    "taskId"
                ],
                "unique": false
            },
            {
                "name": "recordId",
                "keyPaths": [
                    "recordId"
                ],
                "unique": false
            },
            {
                "name": "[recordId+revision]",
                "keyPaths": [
                    "recordId",
                    "revision"
                ],
                "unique": true
            }
        ]
    },
    "agentTaskWrapups": {
        "keyPath": "id",
        "scope": "mixed",
        "indexes": [
            {
                "name": "taskId",
                "keyPaths": [
                    "taskId"
                ],
                "unique": false
            },
            {
                "name": "threadId",
                "keyPaths": [
                    "threadId"
                ],
                "unique": false
            },
            {
                "name": "status",
                "keyPaths": [
                    "status"
                ],
                "unique": false
            },
            {
                "name": "createdAt",
                "keyPaths": [
                    "createdAt"
                ],
                "unique": false
            }
        ]
    },
    "agentTaskWrapupVersions": {
        "keyPath": "versionId",
        "scope": "mixed",
        "indexes": [
            {
                "name": "taskId",
                "keyPaths": [
                    "taskId"
                ],
                "unique": false
            },
            {
                "name": "threadId",
                "keyPaths": [
                    "threadId"
                ],
                "unique": false
            },
            {
                "name": "[id+revision]",
                "keyPaths": [
                    "id",
                    "revision"
                ],
                "unique": true
            }
        ]
    },
    "projectMemories": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "[projectId+status]",
                "keyPaths": [
                    "projectId",
                    "status"
                ],
                "unique": false
            },
            {
                "name": "updatedAt",
                "keyPaths": [
                    "updatedAt"
                ],
                "unique": false
            }
        ]
    },
    "projectMemoryVersions": {
        "keyPath": "versionId",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "memoryId",
                "keyPaths": [
                    "memoryId"
                ],
                "unique": false
            },
            {
                "name": "[memoryId+revision]",
                "keyPaths": [
                    "memoryId",
                    "revision"
                ],
                "unique": true
            }
        ]
    },
    "searchConnections": {
        "keyPath": "id",
        "scope": "device",
        "indexes": []
    },
    "agentGenerationBatches": {
        "keyPath": "id",
        "scope": "mixed",
        "indexes": [
            {
                "name": "sourceCallId",
                "keyPaths": [
                    "sourceCallId"
                ],
                "unique": true
            },
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "threadId",
                "keyPaths": [
                    "threadId"
                ],
                "unique": false
            },
            {
                "name": "runId",
                "keyPaths": [
                    "runId"
                ],
                "unique": false
            },
            {
                "name": "taskId",
                "keyPaths": [
                    "taskId"
                ],
                "unique": false
            },
            {
                "name": "status",
                "keyPaths": [
                    "status"
                ],
                "unique": false
            },
            {
                "name": "updatedAt",
                "keyPaths": [
                    "updatedAt"
                ],
                "unique": false
            }
        ]
    },
    "agentGenerationBatchItems": {
        "keyPath": "id",
        "scope": "mixed",
        "indexes": [
            {
                "name": "batchId",
                "keyPaths": [
                    "batchId"
                ],
                "unique": false
            },
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "threadId",
                "keyPaths": [
                    "threadId"
                ],
                "unique": false
            },
            {
                "name": "jobId",
                "keyPaths": [
                    "jobId"
                ],
                "unique": true
            }
        ]
    },
    "projectReferences": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "mediaId",
                "keyPaths": [
                    "mediaId"
                ],
                "unique": false
            },
            {
                "name": "[projectId+digest]",
                "keyPaths": [
                    "projectId",
                    "digest"
                ],
                "unique": false
            },
            {
                "name": "updatedAt",
                "keyPaths": [
                    "updatedAt"
                ],
                "unique": false
            }
        ]
    },
    "referenceChunks": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "referenceId",
                "keyPaths": [
                    "referenceId"
                ],
                "unique": false
            },
            {
                "name": "[referenceId+revision+index]",
                "keyPaths": [
                    "referenceId",
                    "revision",
                    "index"
                ],
                "unique": true
            }
        ]
    },
    "connectorAliases": {
        "keyPath": "id",
        "scope": "device",
        "indexes": [
            {
                "name": "definitionId",
                "keyPaths": [
                    "definitionId"
                ],
                "unique": false
            }
        ]
    },
    "ipProfiles": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "updatedAt",
                "keyPaths": [
                    "updatedAt"
                ],
                "unique": false
            }
        ]
    },
    "projectIpLinks": {
        "keyPath": "projectId",
        "scope": "content",
        "indexes": [
            {
                "name": "ipId",
                "keyPaths": [
                    "ipId"
                ],
                "unique": false
            }
        ]
    },
    "libraryMaterials": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "kind",
                "keyPaths": [
                    "kind"
                ],
                "unique": false
            },
            {
                "name": "scope.kind",
                "keyPaths": [
                    "scope.kind"
                ],
                "unique": false
            },
            {
                "name": "scope.id",
                "keyPaths": [
                    "scope.id"
                ],
                "unique": false
            },
            {
                "name": "updatedAt",
                "keyPaths": [
                    "updatedAt"
                ],
                "unique": false
            }
        ]
    },
    "materialVersions": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "materialId",
                "keyPaths": [
                    "materialId"
                ],
                "unique": false
            },
            {
                "name": "[materialId+revision]",
                "keyPaths": [
                    "materialId",
                    "revision"
                ],
                "unique": true
            }
        ]
    },
    "materialUses": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "materialId",
                "keyPaths": [
                    "materialId"
                ],
                "unique": false
            },
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "targetId",
                "keyPaths": [
                    "targetId"
                ],
                "unique": false
            },
            {
                "name": "[materialId+projectId]",
                "keyPaths": [
                    "materialId",
                    "projectId"
                ],
                "unique": false
            }
        ]
    },
    "materialEvents": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "materialId",
                "keyPaths": [
                    "materialId"
                ],
                "unique": false
            },
            {
                "name": "createdAt",
                "keyPaths": [
                    "createdAt"
                ],
                "unique": false
            }
        ]
    },
    "audioChapters": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "order",
                "keyPaths": [
                    "order"
                ],
                "unique": false
            }
        ]
    },
    "audioSpeakers": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            }
        ]
    },
    "audioSegments": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "chapterId",
                "keyPaths": [
                    "chapterId"
                ],
                "unique": false
            },
            {
                "name": "speakerId",
                "keyPaths": [
                    "speakerId"
                ],
                "unique": false
            },
            {
                "name": "order",
                "keyPaths": [
                    "order"
                ],
                "unique": false
            }
        ]
    },
    "audioTakes": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "segmentId",
                "keyPaths": [
                    "segmentId"
                ],
                "unique": false
            },
            {
                "name": "mediaId",
                "keyPaths": [
                    "mediaId"
                ],
                "unique": false
            }
        ]
    },
    "audioTracks": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "chapterId",
                "keyPaths": [
                    "chapterId"
                ],
                "unique": false
            },
            {
                "name": "order",
                "keyPaths": [
                    "order"
                ],
                "unique": false
            }
        ]
    },
    "audioClips": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "chapterId",
                "keyPaths": [
                    "chapterId"
                ],
                "unique": false
            },
            {
                "name": "trackId",
                "keyPaths": [
                    "trackId"
                ],
                "unique": false
            },
            {
                "name": "takeId",
                "keyPaths": [
                    "takeId"
                ],
                "unique": false
            }
        ]
    },
    "audioExports": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "mediaId",
                "keyPaths": [
                    "mediaId"
                ],
                "unique": false
            }
        ]
    },
    "musicDrafts": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            }
        ]
    },
    "musicWorks": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "mediaId",
                "keyPaths": [
                    "mediaId"
                ],
                "unique": false
            }
        ]
    },
    "audioGenerationJobs": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "intentId",
                "keyPaths": [
                    "intentId"
                ],
                "unique": true
            },
            {
                "name": "status",
                "keyPaths": [
                    "status"
                ],
                "unique": false
            },
            {
                "name": "updatedAt",
                "keyPaths": [
                    "updatedAt"
                ],
                "unique": false
            }
        ]
    },
    "audioGenerationBatches": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "chapterId",
                "keyPaths": [
                    "chapterId"
                ],
                "unique": false
            },
            {
                "name": "sourceCallId",
                "keyPaths": [
                    "sourceCallId"
                ],
                "unique": true
            },
            {
                "name": "owner.threadId",
                "keyPaths": [
                    "owner.threadId"
                ],
                "unique": false
            },
            {
                "name": "owner.runId",
                "keyPaths": [
                    "owner.runId"
                ],
                "unique": false
            },
            {
                "name": "status",
                "keyPaths": [
                    "status"
                ],
                "unique": false
            },
            {
                "name": "updatedAt",
                "keyPaths": [
                    "updatedAt"
                ],
                "unique": false
            }
        ]
    },
    "audioGenerationBatchItems": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "chapterId",
                "keyPaths": [
                    "chapterId"
                ],
                "unique": false
            },
            {
                "name": "batchId",
                "keyPaths": [
                    "batchId"
                ],
                "unique": false
            },
            {
                "name": "segmentId",
                "keyPaths": [
                    "segmentId"
                ],
                "unique": false
            },
            {
                "name": "intentId",
                "keyPaths": [
                    "intentId"
                ],
                "unique": true
            },
            {
                "name": "jobId",
                "keyPaths": [
                    "jobId"
                ],
                "unique": false
            }
        ]
    },
    "audioArrangementProposals": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "chapterId",
                "keyPaths": [
                    "chapterId"
                ],
                "unique": false
            },
            {
                "name": "kind",
                "keyPaths": [
                    "kind"
                ],
                "unique": false
            },
            {
                "name": "state",
                "keyPaths": [
                    "state"
                ],
                "unique": false
            },
            {
                "name": "updatedAt",
                "keyPaths": [
                    "updatedAt"
                ],
                "unique": false
            }
        ]
    },
    "deviceSettings": {
        "keyPath": "key",
        "scope": "device",
        "indexes": []
    },
    "agentJobs": {
        "keyPath": "id",
        "scope": "mixed",
        "indexes": [
            {
                "name": "callId",
                "keyPaths": [
                    "callId"
                ],
                "unique": true
            },
            {
                "name": "threadId",
                "keyPaths": [
                    "threadId"
                ],
                "unique": false
            },
            {
                "name": "runId",
                "keyPaths": [
                    "runId"
                ],
                "unique": false
            },
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "status",
                "keyPaths": [
                    "status"
                ],
                "unique": false
            },
            {
                "name": "updatedAt",
                "keyPaths": [
                    "updatedAt"
                ],
                "unique": false
            }
        ]
    },
    "agentJobResultChunks": {
        "keyPath": "id",
        "scope": "mixed",
        "indexes": [
            {
                "name": "jobId",
                "keyPaths": [
                    "jobId"
                ],
                "unique": false
            },
            {
                "name": "[jobId+ordinal]",
                "keyPaths": [
                    "jobId",
                    "ordinal"
                ],
                "unique": true
            }
        ]
    },
    "desktopMediaImports": {
        "keyPath": "id",
        "scope": "content",
        "indexes": [
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "status",
                "keyPaths": [
                    "status"
                ],
                "unique": false
            },
            {
                "name": "updatedAt",
                "keyPaths": [
                    "updatedAt"
                ],
                "unique": false
            }
        ]
    },
    "agentPendingInputs": {
        "keyPath": "id",
        "scope": "mixed",
        "indexes": [
            {
                "name": "threadId",
                "keyPaths": [
                    "threadId"
                ],
                "unique": false
            },
            {
                "name": "projectId",
                "keyPaths": [
                    "projectId"
                ],
                "unique": false
            },
            {
                "name": "status",
                "keyPaths": [
                    "status"
                ],
                "unique": false
            },
            {
                "name": "dedupeKey",
                "keyPaths": [
                    "dedupeKey"
                ],
                "unique": true
            },
            {
                "name": "updatedAt",
                "keyPaths": [
                    "updatedAt"
                ],
                "unique": false
            }
        ]
    }
} as const satisfies Record<TableName, TableDefinition>;

export const TABLE_NAMES = Object.keys(PRODUCT_SCHEMA) as TableName[];

export function tableDefinition(name: TableName): TableDefinition {
    const value: TableDefinition | undefined = PRODUCT_SCHEMA[name];
    if (!value) throw new Error("Unknown product table");
    return value;
}
