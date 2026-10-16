import { appTasks, OhosAppContext, OhosPluginId } from '@ohos/hvigor-ohos-plugin';
import { getNode } from '@ohos/hvigor';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 签名材料注入（与 pi-desktop-hos 同一套约定，仓库内**不落任何密钥**）。
 *
 * 优先级：
 *   ① 环境变量 CERTPATH / STORE_FILE / PROFILE / KEY_ALIAS / KEY_PASSWORD / STORE_PASSWORD / SIGN_ALG（CI 用）
 *   ② signing.<SIGN_MODE>.local.json（本地、gitignored）
 * 两者都没有 ⇒ **产出未签名包**（本仓库的编译验证不依赖密钥），不报错。
 *
 * 密码必须是 hvigor DecipherUtil 的 AES-GCM 密文（≥32 位 hex），且 .p12 同级需有 material/{fd,ac,ce} 密钥链。
 */
const PROJECT_ROOT = __dirname;

type SignMode = 'debug' | 'release';

interface SigningMaterial {
  certpath: string;
  storeFile: string;
  profile: string;
  keyAlias: string;
  keyPassword: string;
  storePassword: string;
  signAlg: string;
}

const REQUIRED_FIELDS = ['certpath', 'storeFile', 'profile', 'keyPassword', 'storePassword'] as const;

/** 统一失败出口：清晰报错 + 非零退出，绝不静默回退（避免"以为签了名其实没有"） */
function fail(message: string): never {
  console.error(`[hvigorfile] 签名配置错误：${message}`);
  throw new Error(message);
}

/** 相对路径按项目根解析，绝对路径原样返回 */
function resolveMaterialPaths(m: SigningMaterial): SigningMaterial {
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(PROJECT_ROOT, p));
  return { ...m, certpath: abs(m.certpath), storeFile: abs(m.storeFile), profile: abs(m.profile) };
}

function resolveSignMode(): SignMode {
  const raw = (process.env.SIGN_MODE || '').trim();
  if (raw === '') return 'debug';
  if (raw === 'debug' || raw === 'release') return raw;
  return fail(`非法的 SIGN_MODE="${raw}"：只允许 "debug" 或 "release"（未设置时默认为 "debug"）。`);
}

function loadMaterialFile(file: string): SigningMaterial {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return fail(`无法解析签名配置 ${file}：${(e as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail(`签名配置 ${file} 的顶层必须是 JSON 对象。`);
  }
  const raw = parsed as Record<string, unknown>;
  const str = (key: string): string => (typeof raw[key] === 'string' ? (raw[key] as string) : '');
  const missing = REQUIRED_FIELDS.filter((k) => str(k).trim() === '');
  if (missing.length > 0) {
    return fail(`签名配置 ${file} 缺少必填字段：${missing.join(', ')}。`);
  }
  return resolveMaterialPaths({
    certpath: str('certpath'),
    storeFile: str('storeFile'),
    profile: str('profile'),
    keyAlias: str('keyAlias') || 'debugKey',
    keyPassword: str('keyPassword'),
    storePassword: str('storePassword'),
    signAlg: str('signAlg') || 'SHA256withECDSA'
  });
}

function loadSigningConfig(mode: SignMode): SigningMaterial | null {
  const env = process.env;
  if (env.CERTPATH && env.STORE_FILE && env.STORE_PASSWORD && env.KEY_PASSWORD) {
    return resolveMaterialPaths({
      certpath: env.CERTPATH,
      storeFile: env.STORE_FILE,
      profile: env.PROFILE || '',
      keyAlias: env.KEY_ALIAS || 'debugKey',
      keyPassword: env.KEY_PASSWORD,
      storePassword: env.STORE_PASSWORD,
      signAlg: env.SIGN_ALG || 'SHA256withECDSA'
    });
  }
  const file = path.join(PROJECT_ROOT, `signing.${mode}.local.json`);
  if (fs.existsSync(file)) {
    return loadMaterialFile(file);
  }
  return null;
}

getNode(__filename).afterNodeEvaluate((node) => {
  const mode = resolveSignMode();
  const appContext = node.getContext(OhosPluginId.OHOS_APP_PLUGIN) as OhosAppContext;
  const buildProfileOpt = appContext.getBuildProfileOpt();
  const material = loadSigningConfig(mode);
  const products = buildProfileOpt['app']['products'];

  if (!material) {
    // 无签名材料：摘掉 product 上的 signingConfig 指向，产出未签名包（不报错）。
    if (Array.isArray(products)) {
      for (const p of products) {
        delete p['signingConfig'];
      }
    }
    appContext.setBuildProfileOpt(buildProfileOpt);
    console.warn(
      `[hvigorfile] SIGN_MODE=${mode}，未找到签名材料：` +
      `${path.join(PROJECT_ROOT, `signing.${mode}.local.json`)}（也未提供 CERTPATH/STORE_FILE/STORE_PASSWORD/KEY_PASSWORD 环境变量）。` +
      `本次构建**产出未签名包**。`
    );
    return;
  }

  buildProfileOpt['app']['signingConfigs'] = [
    {
      name: 'default',
      type: 'HarmonyOS',
      material: material
    }
  ];
  if (Array.isArray(products)) {
    for (const p of products) {
      p['signingConfig'] = 'default';
    }
  }
  appContext.setBuildProfileOpt(buildProfileOpt);
});

export default {
  system: appTasks, /* Built-in plugin of hvigor. It cannot be modified. */
  plugins: []       /* Custom plugin to extend the functionality of hvigor. */
};
