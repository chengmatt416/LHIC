import type {
  AppwriteRegistryClient,
  RegistrySkillDetail,
  RegistrySkillSummary,
  SharedSkillCredentialStore,
} from "@lhic/shared-skills";

import type {
  LibrarySearchParams,
  LibrarySearchResult,
  LibrarySkillSummary,
  SkillDetail,
  SkillVersionSummary,
} from "../shared/contracts.js";
import type { SkillsService } from "./skills-service.js";

export interface LibraryServiceOptions {
  skills: SkillsService;
  registry: AppwriteRegistryClient;
  credentialStore: SharedSkillCredentialStore;
  isSignedIn: () => Promise<boolean>;
}

/**
 * Marketplace browsing against the shared Appwrite registry. Every public
 * route requires a signed-in account (the cookie stays in the OS Keychain);
 * downloads upsert the approved record into the local shared mirror through
 * SkillsService so the Skill Depot sees it immediately.
 */
export class LibraryService {
  private readonly skills: SkillsService;
  private readonly registry: AppwriteRegistryClient;
  private readonly credentialStore: SharedSkillCredentialStore;
  private readonly isSignedIn: () => Promise<boolean>;

  public constructor(options: LibraryServiceOptions) {
    this.skills = options.skills;
    this.registry = options.registry;
    this.credentialStore = options.credentialStore;
    this.isSignedIn = options.isSignedIn;
  }

  public async search(
    params: LibrarySearchParams,
  ): Promise<LibrarySearchResult> {
    await this.requireSignedIn();
    const result = await this.registry.search({
      ...(params.category ? { category: params.category } : {}),
      ...(params.q ? { q: params.q } : {}),
      ...(params.cursor ? { cursor: params.cursor } : {}),
    });
    return {
      skills: result.skills.map(toLibrarySkillSummary),
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      ...(result.total !== undefined ? { total: result.total } : {}),
    };
  }

  public async detail(id: string): Promise<SkillDetail> {
    await this.requireSignedIn();
    return toSkillDetail(await this.registry.detail(id));
  }

  public async versions(id: string): Promise<SkillVersionSummary[]> {
    await this.requireSignedIn();
    return (await this.registry.versions(id)).map((version) => ({
      version: version.version,
      contentHash: version.contentHash,
      ...(version.changelog ? { changelog: version.changelog } : {}),
      createdAt: version.createdAt,
    }));
  }

  public async rate(id: string, rating: number): Promise<SkillDetail> {
    await this.requireSignedIn();
    const cookie = await this.requireSessionCookie();
    return toSkillDetail(await this.registry.rate(cookie, id, rating));
  }

  public async download(id: string): Promise<LibrarySkillSummary> {
    await this.requireSignedIn();
    const config = await this.skills.sharedSkillsConfig();
    if (!config) {
      throw new Error("The shared library is not configured.");
    }
    const detail = await this.registry.detail(id);
    const updated = await this.registry.download(id);
    await this.skills.mirrorApprovedSkill({
      registryId: config.registryId,
      skillId: detail.skill.id,
      version: detail.skill.version,
      name: detail.skill.name,
      operationKey: detail.skill.operationKey,
      fingerprint: detail.skill.fingerprint,
      definition: detail.skill.definition,
      fastPathEligible: detail.skill.fastPathEligible,
      contentHash: detail.skill.contentHash,
      updatedAt: detail.skill.updatedAt,
    });
    return toLibrarySkillSummary(updated);
  }

  private async requireSignedIn(): Promise<void> {
    if (!(await this.isSignedIn())) {
      throw new Error("Sign in to browse the shared library.");
    }
  }

  private async requireSessionCookie(): Promise<string> {
    const config = await this.skills.sharedSkillsConfig();
    const cookie = config ? await this.credentialStore.get(config) : undefined;
    if (!cookie) {
      throw new Error("Sign in to browse the shared library.");
    }
    return cookie;
  }
}

function toLibrarySkillSummary(
  skill: RegistrySkillSummary,
): LibrarySkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    ...(skill.description ? { description: skill.description } : {}),
    ...(skill.category ? { category: skill.category } : {}),
    ...(skill.tags?.length ? { tags: [...skill.tags] } : {}),
    version: skill.version,
    downloadCount: skill.downloadCount,
    ratingAvg: skill.ratingAvg,
    ratingCount: skill.ratingCount,
    authorId: skill.authorId,
    ...(skill.authorName ? { authorName: skill.authorName } : {}),
    fastPathEligible: skill.fastPathEligible,
    ...(skill.createdAt ? { createdAt: skill.createdAt } : {}),
  };
}

function toSkillDetail(detail: RegistrySkillDetail): SkillDetail {
  return {
    skill: toLibrarySkillSummary(detail.skill),
    versions: detail.versions.map((version) => ({
      version: version.version,
      contentHash: version.contentHash,
      ...(version.changelog ? { changelog: version.changelog } : {}),
      createdAt: version.createdAt,
    })),
    ...(detail.author
      ? {
          author: {
            userId: detail.author.userId,
            displayName: detail.author.displayName,
            ...(detail.author.bio ? { bio: detail.author.bio } : {}),
            ...(detail.author.avatarUrl
              ? { avatarUrl: detail.author.avatarUrl }
              : {}),
          },
        }
      : {}),
    rating: { avg: detail.rating.avg, count: detail.rating.count },
  };
}
