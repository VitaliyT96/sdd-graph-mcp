import path from 'node:path';
import fs from 'node:fs';
import { ResolverFactory } from 'oxc-resolver';

export interface PathResolverOptions {
  projectRoot: string;
  tsconfigPath?: string;
}

/**
 * High-speed TypeScript/React module path resolver powered by Rust `oxc-resolver`.
 * Resolves relative paths, index barrel files, and tsconfig.json `paths` / `baseUrl` aliases
 * to canonical project-relative POSIX paths (e.g., 'src/components/Button.tsx').
 */
export class PathResolver {
  public readonly projectRoot: string;
  private readonly resolver: ResolverFactory;

  constructor(options: PathResolverOptions) {
    const resolvedRoot = path.resolve(options.projectRoot);
    this.projectRoot = fs.existsSync(resolvedRoot)
      ? fs.realpathSync(resolvedRoot)
      : resolvedRoot;

    const candidateTsconfig =
      options.tsconfigPath ?? path.join(this.projectRoot, 'tsconfig.json');
    const hasTsconfig = fs.existsSync(candidateTsconfig);

    this.resolver = new ResolverFactory({
      extensions: ['.ts', '.tsx', '.d.ts', '.js', '.jsx'],
      extensionAlias: {
        '.js': ['.ts', '.tsx', '.d.ts', '.js'],
        '.jsx': ['.tsx', '.jsx'],
        '.mjs': ['.mts', '.mjs'],
        '.cjs': ['.cts', '.cjs'],
      },
      conditionNames: ['types', 'import', 'require', 'default'],
      mainFields: ['types', 'module', 'main'],
      tsconfig: hasTsconfig
        ? {
            configFile: candidateTsconfig,
            references: 'auto',
          }
        : 'auto',
    });
  }

  /**
   * Resolves a module specifier (e.g. './Button', '@/api/auth', '../ui') from a containing file.
   * Returns a project-relative POSIX path if resolved inside the project root (excluding node_modules),
   * or null if external / unresolvable.
   */
  public resolveImport(
    containingFilePath: string,
    specifier: string
  ): string | null {
    const absContainingFile = path.isAbsolute(containingFilePath)
      ? containingFilePath
      : path.resolve(this.projectRoot, containingFilePath);

    try {
      const result = this.resolver.resolveFileSync(
        absContainingFile,
        specifier
      );
      if (!result.path) {
        return null;
      }

      const resolvedAbs = path.resolve(result.path);
      if (resolvedAbs.includes(`${path.sep}node_modules${path.sep}`)) {
        return null;
      }

      const rel = path.relative(this.projectRoot, resolvedAbs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return null;
      }

      return this.toPosixPath(rel);
    } catch {
      return null;
    }
  }

  public toPosixPath(filePath: string): string {
    const rawAbs = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.projectRoot, filePath);
    const abs = fs.existsSync(rawAbs) ? fs.realpathSync(rawAbs) : rawAbs;
    const rel = path.relative(this.projectRoot, abs);
    return rel.split(path.sep).join('/');
  }

  public clearCache(): void {
    this.resolver.clearCache();
  }
}
