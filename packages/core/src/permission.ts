import { CancellationToken, CommandCategory, Logger, PermissionLevel, PermissionPolicy, Platform, ToolContext } from "./types.js";

export class PermissionEvaluator {
  constructor(
    private readonly policy: PermissionPolicy,
    private readonly platform: Platform = (process.platform as Platform) || "win32"
  ) {}

  evaluate(category: CommandCategory, pattern: string): PermissionLevel {
    const rule = this.findRule(category, pattern);
    if (rule) {
      return rule.level;
    }
    return this.policy.defaultLevel;
  }

  requiresApproval(category: CommandCategory, pattern: string): boolean {
    return this.evaluate(category, pattern) === PermissionLevel.APPROVAL;
  }

  isBlocked(category: CommandCategory, pattern: string): boolean {
    return this.evaluate(category, pattern) === PermissionLevel.BLOCK;
  }

  private findRule(category: CommandCategory, pattern: string): { level: PermissionLevel } | undefined {
    for (const rule of this.policy.rules) {
      if (rule.category !== category) continue;
      if (rule.platforms && rule.platforms.length > 0 && !rule.platforms.includes(this.platform) && !rule.platforms.includes("any")) {
        continue;
      }
      if (this.matchesPattern(pattern, rule.pattern)) {
        return { level: rule.level };
      }
    }
    return undefined;
  }

  private matchesPattern(pattern: string, rulePattern: string): boolean {
    if (rulePattern === "*") return true;
    if (rulePattern.endsWith("*")) {
      const prefix = rulePattern.slice(0, -1);
      return pattern.startsWith(prefix);
    }
    return pattern === rulePattern;
  }
}

export async function withPermissionCheck(
  evaluator: PermissionEvaluator,
  category: CommandCategory,
  pattern: string,
  action: () => Promise<string>,
  context: ToolContext
): Promise<string> {
  if (evaluator.isBlocked(category, pattern)) {
    throw new Error(`Permission denied: ${category} operation "${pattern}" is blocked by policy.`);
  }

  if (evaluator.requiresApproval(category, pattern)) {
    const approved = await context.requestApproval(
      `ForgeAI wants to execute ${category}: ${pattern}`
    );
    if (!approved) {
      throw new Error(`Permission denied: ${category} operation "${pattern}" was not approved.`);
    }
  }

  return action();
}
