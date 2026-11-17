// Firma "ad-hoc" (gratuita) dell'app Mac: senza, i Mac Apple Silicon dicono "file danneggiato".
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function (ctx) {
  if (ctx.electronPlatformName !== 'darwin') return
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  console.log('Firma ad-hoc applicata a', app)
}
