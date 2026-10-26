/**
 * 排障用：用 Electron 自己（DPI 感知进程）截整块屏幕，并把显示器真实几何打印出来。
 * 覆盖层的窗口也在屏幕上，所以这张图就是「用户实际看到的」。不装进包里，只用于自检。
 *
 *   npx electron test/capture.cjs            → 写 shot-full.png
 */
const { app, screen, desktopCapturer, nativeImage } = require('electron')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

async function main() {
  await app.whenReady()
  const display = screen.getPrimaryDisplay()
  const info = {
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
    physicalGuess: {
      width: Math.round(display.bounds.width * display.scaleFactor),
      height: Math.round(display.bounds.height * display.scaleFactor),
    },
  }
  console.log(JSON.stringify(info, null, 1))

  const target = join(__dirname, '..', 'shot-full.png')
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: info.physicalGuess.width, height: info.physicalGuess.height },
  })
  if (sources.length === 0) {
    console.error('no screen source')
    app.exit(1)
    return
  }
  const image = sources[0].thumbnail
  const size = image.getSize()
  const cropped = nativeImage.createFromBuffer(
    // 只留顶部 200 像素，够看状态栏
    image.crop({ x: 0, y: 0, width: size.width, height: Math.min(200, size.height) }).toPNG(),
  )
  writeFileSync(target, cropped.toPNG())
  console.log(JSON.stringify({ source: sources[0].name, full: size, saved: target }))
  app.exit(0)
}

main().catch((error) => {
  console.error(error)
  app.exit(1)
})
