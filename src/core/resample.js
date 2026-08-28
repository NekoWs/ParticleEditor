/* =========================================================================
 * 图像网格面积平均重采样（box filter）
 * 纯逻辑：把 RGBA 源图（Uint8ClampedArray）按 cols×rows 目标网格缩放采样，
 * 返回每格归一化 [r,g,b,a]（Float32Array，长度 cols*rows*4）。
 * 用于导入图片/GIF 时把像素图缩放到粒子网格，避免最近邻抽点丢失细节。
 * ======================================================================= */

// data: 源 RGBA（长度 w*h*4，每通道 0..255）
// out:  可选复用缓冲（长度 cols*rows*4），缺省新建。
export function resampleRGBA(data, w, h, cols, rows, out) {
  out = out || new Float32Array(cols * rows * 4);
  const stepX = w / cols, stepY = h / rows;
  for (let r = 0; r < rows; r++) {
    const y0 = r * stepY;
    const y1 = Math.min(h, (r + 1) * stepY);
    const py0 = Math.max(0, Math.floor(y0));
    const py1 = Math.min(h - 1, Math.ceil(y1) - 1);
    for (let c = 0; c < cols; c++) {
      const x0 = c * stepX;
      const x1 = Math.min(w, (c + 1) * stepX);
      const px0 = Math.max(0, Math.floor(x0));
      const px1 = Math.min(w - 1, Math.ceil(x1) - 1);
      let aSum = 0, rSum = 0, gSum = 0, bSum = 0, wSum = 0;
      for (let py = py0; py <= py1; py++) {
        const wy = Math.min(py + 1, y1) - Math.max(py, y0);
        const rowBase = py * w * 4;
        for (let px = px0; px <= px1; px++) {
          const wx = Math.min(px + 1, x1) - Math.max(px, x0);
          const weight = wx * wy;
          const i = rowBase + px * 4;
          const a = data[i + 3];
          wSum += weight;
          aSum += a * weight;
          rSum += data[i] * a * weight;       // 预乘 alpha 累积
          gSum += data[i + 1] * a * weight;
          bSum += data[i + 2] * a * weight;
        }
      }
      const o = (r * cols + c) * 4;
      out[o + 3] = wSum > 0 ? (aSum / wSum) / 255 : 0;
      if (aSum > 0) {
        out[o] = rSum / aSum / 255;           // 反预乘
        out[o + 1] = gSum / aSum / 255;
        out[o + 2] = bSum / aSum / 255;
      } else {
        out[o] = 0; out[o + 1] = 0; out[o + 2] = 0;
      }
    }
  }
  return out;
}