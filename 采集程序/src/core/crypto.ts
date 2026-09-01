import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { paths } from './paths.js'
import { atomicWrite, sha256 } from './utils.js'

export function findAgeBinary(name: 'age' | 'age-keygen' = 'age'): string {
  const candidates = process.platform === 'win32'
    ? [path.join(paths.root, '采集程序', 'tools', 'age', `${name}.exe`), `${name}.exe`, name]
    : [path.join(paths.root, '采集程序', 'tools', 'age', name), name]
  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && fs.existsSync(candidate)) return candidate
    if (!candidate.includes(path.sep)) {
      const probe = spawnSync(candidate, ['--version'], { windowsHide: true, encoding: 'utf8' })
      if (probe.status === 0) return candidate
    }
  }
  throw new Error(`缺少 ${name}；请先运行项目初始化工具安装已锁定的 age 1.3.1`)
}

export function ensureLocalKeys(): { recipient: string, identityFile: string, signingPublicFile: string, hmacFile: string } {
  fs.mkdirSync(paths.keys, { recursive: true })
  const identityFile = path.join(paths.keys, 'age-identity.txt')
  const recipientFile = path.join(paths.keys, 'age-recipient.txt')
  if (!fs.existsSync(identityFile)) {
    const result = spawnSync(findAgeBinary('age-keygen'), ['-o', identityFile], { windowsHide: true, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`age 密钥生成失败：${result.stderr || result.stdout}`)
    const output = `${result.stdout}\n${result.stderr}`
    const match = output.match(/Public key:\s*(age1[0-9a-z]+)/i)
    if (!match) throw new Error('未能读取 age 公钥')
    fs.writeFileSync(recipientFile, `${match[1]}\n`, 'utf8')
  }
  const signingPrivate = path.join(paths.keys, 'signing-private.pem')
  const signingPublicFile = path.join(paths.keys, 'signing-public.pem')
  if (!fs.existsSync(signingPrivate) || !fs.existsSync(signingPublicFile)) {
    const pair = crypto.generateKeyPairSync('ed25519')
    fs.writeFileSync(signingPrivate, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    fs.writeFileSync(signingPublicFile, pair.publicKey.export({ type: 'spki', format: 'pem' }))
  }
  const hmacFile = path.join(paths.keys, 'hmac-secret.txt')
  if (!fs.existsSync(hmacFile)) fs.writeFileSync(hmacFile, crypto.randomBytes(32).toString('base64url'), { mode: 0o600 })
  const recipient = fs.readFileSync(recipientFile, 'utf8').trim()
  return { recipient, identityFile, signingPublicFile, hmacFile }
}

export function encryptWithAge(inputPath: string, outputPath: string, recipient: string): void {
  const result = spawnSync(findAgeBinary('age'), ['-r', recipient, '-o', outputPath, inputPath], { windowsHide: true, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`age 加密失败：${result.stderr || result.stdout}`)
}

export function decryptWithAge(inputPath: string, outputPath: string, identityFile: string): void {
  const result = spawnSync(findAgeBinary('age'), ['-d', '-i', identityFile, '-o', outputPath, inputPath], { windowsHide: true, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`age 解密失败：${result.stderr || result.stdout}`)
}

export function signingPrivateKey(): crypto.KeyObject {
  const env = process.env.RADAR_SIGNING_PRIVATE_KEY_B64
  const pem = env ? Buffer.from(env, 'base64').toString('utf8') : fs.readFileSync(path.join(paths.keys, 'signing-private.pem'), 'utf8')
  return crypto.createPrivateKey(pem)
}

export function signFile(filePath: string): string {
  return crypto.sign(null, fs.readFileSync(filePath), signingPrivateKey()).toString('base64')
}

export function verifyFile(filePath: string, signature: string, publicKeyFile = path.join(paths.keys, 'signing-public.pem')): boolean {
  const publicKey = crypto.createPublicKey(fs.readFileSync(publicKeyFile, 'utf8'))
  return crypto.verify(null, fs.readFileSync(filePath), publicKey, Buffer.from(signature, 'base64'))
}

export async function writeManifest(manifestPath: string, encryptedPath: string, eventCount: number, runId: string): Promise<Record<string, unknown>> {
  const manifest = { schemaVersion: '1.0', runId, eventCount, encryptedFile: path.basename(encryptedPath), sha256: sha256(fs.readFileSync(encryptedPath)), createdAt: new Date().toISOString() }
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const signature = signFile(manifestPath)
  await atomicWrite(`${manifestPath}.sig`, `${signature}\n`)
  return manifest
}
