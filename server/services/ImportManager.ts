import { type IStorage } from "../storage.js";
import { PathMappingService } from "./PathMappingService.js";
import { PlatformMappingService } from "./PlatformMappingService.js";
import { ArchiveService } from "./ArchiveService.js";
import {
  ImportStrategy,
  ImportReview,
  PCImportStrategy,
  sanitizeFsName,
} from "./ImportStrategies.js";
import { DownloaderManager } from "../downloaders.js";
import fs from "fs-extra";
import path from "node:path";
import { parseReleaseMetadata } from "../../shared/title-utils.js";
import { logger } from "../logger.js";
import { extractHostnameFromUrl } from "../url-utils.js";

const RELEASE_PLATFORM_TO_IGDB_ID: Record<string, number> = {
  nes: 18,
  snes: 19,
  n64: 4,
  gamecube: 21,
  wii: 5,
  gb: 33,
  gbc: 22,
  gba: 24,
  nds: 20,
  "3ds": 37,
  switch: 130,
  ps1: 7,
  ps2: 8,
  ps3: 9,
  psp: 38,
  "game gear": 35,
  "master system": 64,
  "mega drive": 29,
  dreamcast: 23,
  "atari 2600": 59,
  "neo geo": 80,
  pc: 6,
};

const MAX_PATH_RETRY = 5;

export class ImportManager {
  private readonly pathRetryCount = new Map<string, number>();

  constructor(
    private readonly storage: IStorage,
    private readonly pathService: PathMappingService,
    private readonly _platformService: PlatformMappingService,
    private readonly archiveService: ArchiveService
  ) {}

  private extractPlatformIdFromElement(p: unknown): number | undefined {
    if (typeof p === "number") return p;
    if (typeof p === "string" && /^\d+$/.test(p)) return Number(p);
    if (p && typeof p === "object" && "id" in p) {
      const id = (p as { id?: unknown }).id;
      if (typeof id === "number") return id;
      if (typeof id === "string" && /^\d+$/.test(id)) return Number(id);
    }
    return undefined;
  }

  private getPrimaryPlatformId(game: { platforms?: unknown }): number | undefined {
    if (!Array.isArray(game.platforms)) return undefined;
    for (const p of game.platforms) {
      const platformId = this.extractPlatformIdFromElement(p);
      if (platformId !== undefined) return platformId;
    }
    return undefined;
  }

  private isPlatformEnabled(platformId: number | undefined, allowed: number[]): boolean {
    if (!platformId) return allowed.length === 0;
    return allowed.length === 0 || allowed.includes(platformId);
  }

  private getReleasePlatformKey(downloadTitle: string): string | null {
    const parsed = parseReleaseMetadata(downloadTitle);
    if (!parsed.platform) return null;
    return parsed.platform.trim().toLowerCase();
  }

  private getReleasePlatformIgdbId(releasePlatformKey: string | null): number | undefined {
    if (!releasePlatformKey) return undefined;
    return RELEASE_PLATFORM_TO_IGDB_ID[releasePlatformKey];
  }

  private async extractIfArchive(sourcePath: string): Promise<string> {
    if (!this.archiveService.isArchive(sourcePath)) return sourcePath;
    const extractDir = sourcePath + "_extracted";
    await this.archiveService.extract(sourcePath, extractDir);
    return extractDir;
  }

  private extractRemoteHost(downloaderUrl: string): string | undefined {
    const remoteHost = extractHostnameFromUrl(downloaderUrl);
    if (!remoteHost) {
      logger.warn({ downloaderUrl }, "Invalid downloader URL");
    }
    return remoteHost ?? undefined;
  }

  private async resolveLocalPath(
    remoteDownloadPath: string,
    downloaderId: string
  ): Promise<{ localPath: string; downloaderName: string }> {
    const downloader = await this.storage.getDownloader(downloaderId);
    const remoteHost = downloader ? this.extractRemoteHost(downloader.url) : undefined;
    const downloaderName = downloader?.name ?? downloaderId;
    logger.debug(
      { remoteDownloadPath, downloaderName, remoteHost },
      "[ImportManager] Resolving path"
    );
    const localPath = await this.pathService.translatePath(remoteDownloadPath, remoteHost);
    return { localPath, downloaderName };
  }

  private shouldSkipPCPlatform(
    _strategy: ImportStrategy,
    downloadTitle: string,
    game: NonNullable<Awaited<ReturnType<IStorage["getGame"]>>>,
    importPlatformIds: number[]
  ): boolean {
    const gamePrimaryPlatformId = this.getPrimaryPlatformId(game);
    const releasePlatformKey = this.getReleasePlatformKey(downloadTitle);
    const releasePlatformId = this.getReleasePlatformIgdbId(releasePlatformKey);
    const effectivePlatformId = releasePlatformId ?? gamePrimaryPlatformId;

    if (!this.isPlatformEnabled(effectivePlatformId, importPlatformIds)) {
      logger.info(
        { gameTitle: game.title, effectivePlatformId },
        "[ImportManager] Skipping import: platform not in filter"
      );
      return true;
    }
    return false;
  }

  private async finalizeImport(
    downloadId: string,
    game: NonNullable<Awaited<ReturnType<IStorage["getGame"]>>>
  ): Promise<void> {
    await this.storage.updateGameDownloadStatus(downloadId, "imported");
    if (game.status !== "owned") {
      await this.storage.updateGameStatus(game.id, { status: "owned" });
    }
  }

  async processImport(downloadId: string, remoteDownloadPath: string): Promise<void> {
    const download = await this.storage.getGameDownload(downloadId);
    if (!download) {
      logger.warn({ downloadId }, "[ImportManager] Download not found");
      return;
    }

    const game = await this.storage.getGame(download.gameId);
    if (!game) {
      logger.error({ downloadId }, "[ImportManager] Game not found for download");
      await this.storage.updateGameDownloadStatus(downloadId, "error");
      return;
    }

    const config = await this.storage.getImportConfig(game.userId ?? undefined);
    if (!config.enablePostProcessing) {
      logger.info({ downloadId }, "[ImportManager] Post-processing disabled, skipping");
      await this.storage.updateGameDownloadStatus(downloadId, "completed");
      return;
    }

    let localPath: string | undefined;
    let processingPath: string | undefined;

    try {
      await this.storage.updateGameDownloadStatus(downloadId, "unpacking");

      const resolved = await this.resolveLocalPath(remoteDownloadPath, download.downloaderId);
      localPath = resolved.localPath;
      const downloaderName = resolved.downloaderName;

      logger.debug({ localPath }, "[ImportManager] Checking path accessibility");
      if (!(await fs.pathExists(localPath))) {
        const retries = (this.pathRetryCount.get(downloadId) ?? 0) + 1;
        if (retries < MAX_PATH_RETRY) {
          this.pathRetryCount.set(downloadId, retries);
          logger.warn(
            {
              localPath,
              downloaderName,
              remoteDownloadPath,
              retry: retries,
              maxRetry: MAX_PATH_RETRY,
            },
            "[ImportManager] Path not accessible — retrying next cycle"
          );
          await this.storage.updateGameDownloadStatus(downloadId, "downloading");
          return;
        }
        this.pathRetryCount.delete(downloadId);
        logger.warn(
          { localPath, downloaderName, remoteDownloadPath },
          "[ImportManager] Path not accessible after retries — check path mappings under Settings → Path Mappings"
        );
        await this.storage.updateGameDownloadStatus(downloadId, "manual_review_required");
        return;
      }
      this.pathRetryCount.delete(downloadId);

      processingPath = config.autoUnpack ? await this.extractIfArchive(localPath) : localPath;

      const strategy = new PCImportStrategy();
      const libraryRoot = config.libraryRoot || "/data";

      if (
        this.shouldSkipPCPlatform(
          strategy,
          download.downloadTitle || "",
          game,
          config.importPlatformIds
        )
      ) {
        await this.storage.updateGameDownloadStatus(downloadId, "completed");
        return;
      }

      await fs.ensureDir(libraryRoot);

      const plan = await strategy.planImport(processingPath, game, libraryRoot, config);

      if (plan.needsReview) {
        logger.info(
          { gameTitle: game.title, reviewReason: plan.reviewReason },
          "[ImportManager] Manual review required"
        );
        await this.storage.updateGameDownloadStatus(downloadId, "manual_review_required");
        return;
      }

      await this.storage.updateGameDownloadStatus(downloadId, "completed_pending_import");
      await strategy.executeImport(plan, config.transferMode);

      if (processingPath !== localPath) {
        await fs.remove(processingPath);
      }

      await this.finalizeImport(downloadId, game);

      if (
        config.autoDeleteAfterImport &&
        (config.transferMode === "copy" || config.transferMode === "move")
      ) {
        const downloader = await this.storage.getDownloader(download.downloaderId);
        if (downloader && download.downloadHash) {
          const result = await DownloaderManager.removeDownload(
            downloader,
            download.downloadHash,
            true
          );
          if (!result.success) {
            logger.warn(
              { downloadId, downloadHash: download.downloadHash },
              "[ImportManager] Auto-delete after import failed"
            );
          }
        }
      }
    } catch (err) {
      logger.error({ err, downloadId }, "[ImportManager] Import failed");
      if (processingPath && localPath && processingPath !== localPath) {
        await fs.remove(processingPath).catch(() => undefined);
      }
      try {
        await this.storage.updateGameDownloadStatus(downloadId, "error");
      } catch (statusErr) {
        logger.error({ statusErr, downloadId }, "[ImportManager] Failed to set error status");
      }
    }
  }

  private async resolveConfirmOriginalPath(
    overridePath: string | undefined,
    download: NonNullable<Awaited<ReturnType<IStorage["getGameDownload"]>>>
  ): Promise<string | undefined> {
    if (overridePath) return overridePath;

    const downloader = await this.storage.getDownloader(download.downloaderId);
    if (!downloader) return undefined;

    const details = await DownloaderManager.getDownloadDetails(downloader, download.downloadHash);
    if (!details || !details.downloadDir) return undefined;

    const remotePath = `${details.downloadDir}/${details.name}`;
    const remoteHost = this.extractRemoteHost(downloader.url);
    return this.pathService.translatePath(remotePath, remoteHost);
  }

  async planConfirmImport(
    downloadId: string,
    overrideSourcePath?: string,
    callerUserId?: string
  ): Promise<{ originalPath: string | null; proposedPath: string }> {
    const download = await this.storage.getGameDownload(downloadId, callerUserId);
    if (!download) throw new Error(`Download ${downloadId} not found`);

    const game = await this.storage.getGame(download.gameId);
    if (!game) throw new Error(`Game not found for download ${downloadId}`);

    const config = await this.storage.getImportConfig(game.userId ?? undefined);
    const libraryRoot = config.libraryRoot || "/data";

    let resolvedOriginalPath: string | null = null;
    try {
      resolvedOriginalPath =
        (await this.resolveConfirmOriginalPath(overrideSourcePath, download)) ?? null;
    } catch {
      // Source resolution failed — still return a proposed path based on game title
    }

    const fallbackProposedPath = path.join(libraryRoot, "PC", sanitizeFsName(game.title));

    if (resolvedOriginalPath) {
      try {
        const strategy = new PCImportStrategy();
        const plan = await strategy.planImport(resolvedOriginalPath, game, libraryRoot, config);
        return { originalPath: resolvedOriginalPath, proposedPath: plan.proposedPath };
      } catch {
        // Source not yet accessible (e.g. still in incomplete folder) — path is known but can't be stat'd
        return { originalPath: resolvedOriginalPath, proposedPath: fallbackProposedPath };
      }
    }

    return { originalPath: null, proposedPath: fallbackProposedPath };
  }

  async confirmImport(
    downloadId: string,
    overridePlan?: ImportReview & {
      transferMode?: "move" | "copy" | "hardlink" | "symlink";
      unpack?: boolean;
    },
    callerUserId?: string
  ): Promise<void> {
    const download = await this.storage.getGameDownload(downloadId, callerUserId);

    if (!download) {
      throw new Error(`Download ${downloadId} not found`);
    }

    if (!overridePlan) {
      throw new Error("Confirmation requires a plan");
    }

    const resolvedOriginalPath = await this.resolveConfirmOriginalPath(
      overridePlan.originalPath,
      download
    );

    if (!resolvedOriginalPath) {
      throw new Error(
        "Source path could not be resolved — the download may no longer be tracked by the download client. Please specify the source path manually."
      );
    }

    const game = await this.storage.getGame(download.gameId);
    if (!game) {
      throw new Error(`Game not found for download ${downloadId}`);
    }

    const config = await this.storage.getImportConfig(game.userId ?? undefined);

    if (!overridePlan.proposedPath) {
      throw new Error("Proposed path is required for import validation");
    }

    const resolvedRoot = path.resolve(config.libraryRoot);
    const resolvedTarget = path.resolve(overridePlan.proposedPath);
    const insideRoot =
      resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
    if (!insideRoot) {
      throw new Error("Proposed path is outside configured library root");
    }

    const processPath = overridePlan.unpack
      ? await this.extractIfArchive(resolvedOriginalPath)
      : resolvedOriginalPath;

    const planToExecute: ImportReview = {
      ...overridePlan,
      originalPath: processPath,
    };

    const transferMode = overridePlan.transferMode ?? config.transferMode;

    try {
      const strategy = new PCImportStrategy();
      await strategy.executeImport(planToExecute, transferMode);

      await this.finalizeImport(downloadId, game);
    } catch (err) {
      logger.error({ err, downloadId }, "[ImportManager] confirmImport failed");
      try {
        await this.storage.updateGameDownloadStatus(downloadId, "error");
      } catch (statusErr) {
        logger.error({ statusErr, downloadId }, "[ImportManager] Failed to set error status");
      }
      throw err;
    } finally {
      if (processPath !== resolvedOriginalPath) {
        await fs.remove(processPath);
      }
    }
  }
}
