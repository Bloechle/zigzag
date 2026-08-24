/*
 * ZigZag - adaptive document image binarization and background removal.
 *
 * Implementation of the original algorithm published at ACM DocEng 2024:
 * Bloechle, Hennebert, Gisler - "ZigZag: A Robust Adaptive Approach to
 * Non-Uniformly Illuminated Document Image Binarization"
 * (DOI 10.1145/3685650.3685661).
 *
 * Two-pass local mean filtering: Pass A classifies likely background pixels
 * against the weighted local mean; Pass B normalizes each pixel against the
 * local mean of background-only pixels, equalizing illumination before a
 * single global Otsu threshold.
 *
 * Single file, no dependencies, separable rolling sums (O(n)), parallel.
 * Run directly with Java 11+ (no compilation step):
 *
 *     java ZigZag.java photo.jpg --mode=binary
 *
 * Copyright (c) Jean-Luc Bloechle - AGPL v3
 */

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.File;
import java.util.Locale;
import java.util.stream.IntStream;

public class ZigZag {

    public static final int OTSU_CAP = 250;
    static final java.util.List<String> MODES = java.util.List.of("binary", "gray", "color");

    /** Pipeline options. */
    public static class Options {
        public String mode = "binary";     // binary | gray | color
        public int size = 30;
        public int weight = 90;
        public boolean upsample = true;
        public int thresholdOffset = 0;    // manual shift of the auto Otsu threshold
    }

    /** Parameters used, auto Otsu and applied threshold. */
    public static class Info {
        public int size, weight, otsu, threshold;
    }

    public static class Result {
        public BufferedImage image;
        public Info info;
    }

    // -- helpers --------------------------------------------------------------

    /** Rec. 601 luma, round-half-up, from 0xRRGGBB pixels. */
    static double[] grayImage(int[] rgb) {
        double[] gray = new double[rgb.length];
        IntStream.range(0, rgb.length).parallel().forEach(i -> {
            int p = rgb[i];
            int r = (p >> 16) & 0xFF, g = (p >> 8) & 0xFF, b = p & 0xFF;
            gray[i] = Math.floor(r * 0.299 + g * 0.587 + b * 0.114 + 0.5);
        });
        return gray;
    }

    /** Raw BGR bytes when the raster is the standard packed layout, else null. */
    static byte[] bgrBytesOrNull(BufferedImage img) {
        if (img.getType() != BufferedImage.TYPE_3BYTE_BGR) return null;
        java.awt.image.SampleModel sm = img.getRaster().getSampleModel();
        if (!(sm instanceof java.awt.image.ComponentSampleModel)) return null;
        java.awt.image.ComponentSampleModel csm = (java.awt.image.ComponentSampleModel) sm;
        if (csm.getPixelStride() != 3 || csm.getScanlineStride() != img.getWidth() * 3) return null;
        return ((java.awt.image.DataBufferByte) img.getRaster().getDataBuffer()).getData();
    }

    /** RGB pixels packed as 0xRRGGBB, read as sRGB samples.
     *
     *  Java models TYPE_BYTE_GRAY and TYPE_USHORT_GRAY in a *linear* gray colour
     *  space, so getRGB() silently applies a linear->sRGB gamma conversion
     *  (sample 1 becomes 13, 128 becomes 186). OpenCV and the browser canvas
     *  take the stored samples as sRGB, so grayscale scans would binarize
     *  differently in Java. We therefore read the raster directly, and only fall
     *  back to getRGB() for palette images, where the colour model *is* the
     *  pixel data. */
    static int[] readRgb(BufferedImage img) {
        int w = img.getWidth(), h = img.getHeight(), n = w * h;
        byte[] bgr = bgrBytesOrNull(img);
        if (bgr != null) {
            int[] px = new int[n];
            IntStream.range(0, n).parallel().forEach(i -> {
                int o = i * 3;
                px[i] = ((bgr[o + 2] & 0xFF) << 16) | ((bgr[o + 1] & 0xFF) << 8) | (bgr[o] & 0xFF);
            });
            return px;
        }
        if (img.getColorModel() instanceof java.awt.image.IndexColorModel) {
            int[] px = img.getRGB(0, 0, w, h, null, 0, w);
            IntStream.range(0, n).parallel().forEach(i -> px[i] &= 0xFFFFFF);
            return px;
        }
        java.awt.image.Raster ras = img.getRaster();
        boolean rgbBands = ras.getNumBands() >= 3;              // else gray (+ alpha)
        int shift = Math.max(0, ras.getSampleModel().getSampleSize(0) - 8);   // 16-bit -> 8
        int[] s0 = ras.getSamples(0, 0, w, h, 0, (int[]) null);
        int[] s1 = rgbBands ? ras.getSamples(0, 0, w, h, 1, (int[]) null) : s0;
        int[] s2 = rgbBands ? ras.getSamples(0, 0, w, h, 2, (int[]) null) : s0;
        int[] px = new int[n];
        IntStream.range(0, n).parallel().forEach(i -> {
            int r = Math.min(255, s0[i] >> shift);
            int g = Math.min(255, s1[i] >> shift);
            int b = Math.min(255, s2[i] >> shift);
            px[i] = (r << 16) | (g << 8) | b;
        });
        return px;
    }

    /** 2D box sum over [x-r..x+r]^2, zero-padded (truncated window), O(n). */
    static double[] boxSum(double[] src, int w, int h, int r) {
        double[] tmp = new double[w * h];
        IntStream.range(0, h).parallel().forEach(y -> {   // horizontal pass
            int base = y * w;
            double sum = 0;
            int initR = Math.min(r, w - 1);
            for (int x = 0; x <= initR; x++) sum += src[base + x];
            tmp[base] = sum;
            for (int x = 1; x < w; x++) {
                int add = x + r, rem = x - r - 1;
                if (add < w) sum += src[base + add];
                if (rem >= 0) sum -= src[base + rem];
                tmp[base + x] = sum;
            }
        });
        double[] dst = new double[w * h];
        IntStream.range(0, w).parallel().forEach(x -> {   // vertical pass
            double sum = 0;
            int initB = Math.min(r, h - 1);
            for (int y = 0; y <= initB; y++) sum += tmp[y * w + x];
            dst[x] = sum;
            for (int y = 1; y < h; y++) {
                int add = y + r, rem = y - r - 1;
                if (add < h) sum += tmp[add * w + x];
                if (rem >= 0) sum -= tmp[rem * w + x];
                dst[y * w + x] = sum;
            }
        });
        return dst;
    }

    static int[] histogram(double[] values, int w, int h, int marginPercent) {
        int[] hist = new int[256];
        int mw = w * marginPercent / 100, mh = h * marginPercent / 100;
        for (int y = mh; y < h - mh; y++) {
            for (int x = mw; x < w - mw; x++) {
                int v = (int) values[y * w + x];                 // truncation
                hist[Math.min(255, Math.max(0, v))]++;
            }
        }
        return hist;
    }

    /** Standard Otsu, first-maximum tie-break, capped at OTSU_CAP. */
    static int otsu(int[] hist) {
        long total = 0;
        double sum = 0;
        for (int i = 0; i < 256; i++) { total += hist[i]; sum += (double) i * hist[i]; }
        if (total == 0) return 127;
        double sumB = 0, maxVar = -1;
        long wB = 0;
        int thr = 127;
        for (int t = 0; t < 256; t++) {
            wB += hist[t];
            if (wB == 0) continue;
            long wF = total - wB;
            if (wF == 0) break;
            sumB += (double) t * hist[t];
            double mB = sumB / wB;
            double mF = (sum - sumB) / wF;
            double v = (double) wB * wF * (mB - mF) * (mB - mF);
            if (v > maxVar) { maxVar = v; thr = t; }
        }
        return Math.min(OTSU_CAP, thr);
    }

    /** Center-aligned 2x bilinear upsampling fused with thresholding:
     *  vertical interpolation pass, then the horizontal pass writes the
     *  binary bytes directly (no full-resolution float buffer). */
    static byte[] upsampleBinarize(double[] src, int w, int h, int thr) {
        int W = w * 2, H = h * 2;
        double[] rows = new double[H * w];
        IntStream.range(0, H).parallel().forEach(y2 -> {
            double sy = (y2 + 0.5) * 0.5 - 0.5;
            int y0 = (int) Math.floor(sy);
            double fy = sy - y0;
            int ya = Math.min(h - 1, Math.max(0, y0)) * w;
            int yb = Math.min(h - 1, Math.max(0, y0 + 1)) * w;
            int base = y2 * w;
            for (int x = 0; x < w; x++) rows[base + x] = src[ya + x] * (1 - fy) + src[yb + x] * fy;
        });
        byte[] out = new byte[H * W];
        IntStream.range(0, H).parallel().forEach(y2 -> {
            int base = y2 * w, ob = y2 * W;
            for (int x2 = 0; x2 < W; x2++) {
                double sx = (x2 + 0.5) * 0.5 - 0.5;
                int x0 = (int) Math.floor(sx);
                double fx = sx - x0;
                int xa = Math.min(w - 1, Math.max(0, x0));
                int xb = Math.min(w - 1, Math.max(0, x0 + 1));
                double v = rows[base + xa] * (1 - fx) + rows[base + xb] * fx;
                out[ob + x2] = (byte) (v >= thr ? 255 : 0);
            }
        });
        return out;
    }

    /** Antialiased cleanup coverage: threshold the 2x-upsampled foreground and
     *  average each 2x2 block back to 1x -> white coverage in {0,.25,.5,.75,1}.
     *  Same center-aligned bilinear samples as upsampleBinarize, never
     *  materializing the 2x image. */
    static double[] coverage(double[] src, int w, int h, int thr) {
        double[] cov = new double[w * h];
        IntStream.range(0, h).parallel().forEach(y -> {
            double[] rowA = new double[w];   // y2 = 2y   (sy = y - 0.25)
            double[] rowB = new double[w];   // y2 = 2y+1 (sy = y + 0.25)
            int ya = Math.max(0, y - 1) * w, yc = y * w, yb = Math.min(h - 1, y + 1) * w;
            for (int x = 0; x < w; x++) {
                rowA[x] = src[ya + x] * 0.25 + src[yc + x] * 0.75;
                rowB[x] = src[yc + x] * 0.75 + src[yb + x] * 0.25;
            }
            for (int x = 0; x < w; x++) {
                int xa = Math.max(0, x - 1), xb = Math.min(w - 1, x + 1);
                int tl = (rowA[xa] * 0.25 + rowA[x] * 0.75) >= thr ? 1 : 0;
                int tr = (rowA[x] * 0.75 + rowA[xb] * 0.25) >= thr ? 1 : 0;
                int bl = (rowB[xa] * 0.25 + rowB[x] * 0.75) >= thr ? 1 : 0;
                int br = (rowB[x] * 0.75 + rowB[xb] * 0.25) >= thr ? 1 : 0;
                cov[yc + x] = (tl + tr + bl + br) * 0.25;
            }
        });
        return cov;
    }

    // -- core pipeline (Algorithm 1 of the paper) -----------------------------

    public static Result process(BufferedImage img, Options opts) {
        if (!MODES.contains(opts.mode)) {
            throw new IllegalArgumentException(
                    "invalid mode: " + opts.mode + " (expected binary, gray or color)");
        }
        int w = img.getWidth(), h = img.getHeight(), n = w * h;
        int r = opts.size / 2;
        double wf = opts.weight / 100.0;
        int[] rgb = readRgb(img);          // decoded once, reused by color mode
        double[] gray = grayImage(rgb);

        // Pass A - background classification against the weighted local mean
        double[] sumAll = boxSum(gray, w, h, r);
        double[] maskVal = new double[n];   // gray value where background, else 0
        double[] maskCnt = new double[n];   // 1 where background, else 0
        IntStream.range(0, h).parallel().forEach(y -> {
            int cy = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1;
            for (int x = 0; x < w; x++) {
                int i = y * w + x;
                int cx = Math.min(w - 1, x + r) - Math.max(0, x - r) + 1;
                if (gray[i] >= wf * sumAll[i] / (cx * cy)) {
                    maskVal[i] = gray[i];
                    maskCnt[i] = 1;
                }
            }
        });

        // Pass B - normalization against the local mean of background-only pixels
        double[] cntBg = boxSum(maskCnt, w, h, r);

        Info info = new Info();
        info.size = opts.size;
        info.weight = opts.weight;
        Result res = new Result();
        res.info = info;

        double[] fg = normalize(gray, maskVal, cntBg, w, h, r);

        // Otsu threshold on the foreground histogram (10% margin crop),
        // optionally shifted by the manual offset
        int auto = otsu(histogram(fg, w, h, 10));
        int thr = Math.min(255, Math.max(0, auto + opts.thresholdOffset));
        info.otsu = auto;
        info.threshold = thr;

        if (opts.mode.equals("gray")) {
            // antialiased background cleanup: blend toward white with the 2x2
            // coverage of the thresholded 2x foreground - sharp text, soft cutoff
            double[] cov = coverage(fg, w, h, thr);
            byte[] px = new byte[n];
            IntStream.range(0, n).parallel().forEach(i ->
                px[i] = (byte) (int) Math.min(255, Math.max(0,
                        cov[i] * 255.0 + (1.0 - cov[i]) * fg[i])));
            BufferedImage out = new BufferedImage(w, h, BufferedImage.TYPE_BYTE_GRAY);
            out.getRaster().setDataElements(0, 0, w, h, px);
            res.image = out;
            return res;
        }

        if (opts.mode.equals("color")) {
            // luminance-guided: normalize once on luma, re-apply the original
            // colors, then the same antialiased white blend as gray mode
            double[] cov = coverage(fg, w, h, thr);
            int[] px = new int[n];
            IntStream.range(0, n).parallel().forEach(i -> {
                double ratio = fg[i] / Math.max(1, gray[i]);
                double c = cov[i], k = 1.0 - c;
                int p = rgb[i], v = 0;
                for (int ch = 0; ch < 3; ch++) {
                    int shift = 16 - 8 * ch;
                    double tc = Math.min(255, ((p >> shift) & 0xFF) * ratio);
                    v |= ((int) Math.min(255, Math.max(0, c * 255.0 + k * tc))) << shift;
                }
                px[i] = v;
            });
            BufferedImage out = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
            out.setRGB(0, 0, w, h, px, 0, w);
            res.image = out;
            return res;
        }

        // binary - threshold, 2x upsample by default for detail preservation
        int W = opts.upsample ? w * 2 : w, H = opts.upsample ? h * 2 : h;
        byte[] px;
        if (opts.upsample) {
            px = upsampleBinarize(fg, w, h, thr);
        } else {
            px = new byte[n];
            IntStream.range(0, n).parallel().forEach(i -> px[i] = (byte) (fg[i] >= thr ? 255 : 0));
        }
        BufferedImage out = new BufferedImage(W, H, BufferedImage.TYPE_BYTE_GRAY);
        out.getRaster().setDataElements(0, 0, W, H, px);
        res.image = out;
        return res;
    }

    /** fg = 255 if v >= mean_bg else v*256/mean_bg; all-foreground windows -> 255. */
    static double[] normalize(double[] channel, double[] masked, double[] cntBg,
                              int w, int h, int r) {
        double[] sumBg = boxSum(masked, w, h, r);
        double[] fg = new double[w * h];
        IntStream.range(0, w * h).parallel().forEach(i -> {
            double meanBg = cntBg[i] > 0.5 ? sumBg[i] / cntBg[i] : 0;
            double v = channel[i];
            fg[i] = (v >= meanBg || cntBg[i] < 0.5)
                    ? 255
                    : Math.min(255, v * 256 / Math.max(1, meanBg));
        });
        return fg;
    }

    // -- CLI ------------------------------------------------------------------

    static final String USAGE = "Usage: java ZigZag.java <inputs...> [--output=path|dir] "
            + "[--mode=binary|gray|color] [--size=N] [--weight=N] [--threshold-offset=N] "
            + "[--no-upsample] [--time] [--csv=path]";

    public static void main(String[] args) throws Exception {
        java.util.List<String[]> inputs = new java.util.ArrayList<>();
        String output = null, csvPath = null;
        boolean showTime = false;
        Options opts = new Options();
        for (String a : args) {
            if (a.startsWith("--mode=")) opts.mode = a.substring(7);
            else if (a.startsWith("--size=")) opts.size = Integer.parseInt(a.substring(7));
            else if (a.startsWith("--weight=")) opts.weight = Integer.parseInt(a.substring(9));
            else if (a.startsWith("--threshold-offset=")) opts.thresholdOffset = Integer.parseInt(a.substring(19));
            else if (a.startsWith("--output=")) output = a.substring(9);
            else if (a.equals("--no-upsample")) opts.upsample = false;
            else if (a.equals("--time")) showTime = true;
            else if (a.startsWith("--csv=")) csvPath = a.substring(6);
            else if (a.equals("--help") || a.equals("-h")) {
                System.out.println(USAGE);
                return;
            }
            else if (a.startsWith("--")) {
                System.out.println("Unknown option: " + a);
                return;
            }
            else inputs.addAll(expand(a));
        }
        if (!MODES.contains(opts.mode)) {
            System.out.println("Invalid --mode=" + opts.mode + " (expected binary, gray or color)");
            return;
        }
        if (inputs.isEmpty()) {
            boolean hadPatterns = java.util.Arrays.stream(args).anyMatch(a -> !a.startsWith("--"));
            System.out.println(hadPatterns ? "No input images found." : USAGE);
            return;
        }

        File outDir = null;
        if (output != null && (inputs.size() > 1 || new File(output).isDirectory()
                || output.endsWith(File.separator) || output.endsWith("/"))) {
            outDir = new File(output);
            outDir.mkdirs();
        }

        StringBuilder csv = new StringBuilder(
                "input,output,mode,size,weight,otsu,threshold,backend,in_width,in_height,"
                + "out_width,out_height,load_ms,proc_ms,save_ms\n");
        double totLoad = 0, totProc = 0, totSave = 0;
        int count = 0;
        for (String[] entry : inputs) {
            String input = entry[0], rel = entry[1];
            File in = new File(input);
            if (!in.exists()) {
                System.out.println("File not found: " + input);
                continue;
            }
            long t0 = System.nanoTime();
            BufferedImage img = ImageIO.read(in);
            if (img == null) {
                System.out.println("Cannot read image: " + input);
                continue;
            }
            double tLoad = (System.nanoTime() - t0) / 1e6;

            t0 = System.nanoTime();
            Result res = process(img, opts);
            double tProc = (System.nanoTime() - t0) / 1e6;

            File dst;
            if (outDir != null) {
                dst = new File(outDir, rel.replaceFirst("\\.[^.]+$", "") + "_ZZ.png");
                if (dst.getParentFile() != null) dst.getParentFile().mkdirs();
            } else {
                dst = output != null ? new File(output)
                        : new File(input.replaceFirst("\\.[^.]+$", "") + "_ZZ.png");
            }
            t0 = System.nanoTime();
            ImageIO.write(res.image, "png", dst);
            double tSave = (System.nanoTime() - t0) / 1e6;

            totLoad += tLoad;
            totProc += tProc;
            totSave += tSave;
            count++;
            Info f = res.info;
            csv.append(String.format(Locale.ROOT, "%s,%s,%s,%d,%d,%d,%d,cpu,%d,%d,%d,%d,%.1f,%.1f,%.1f\n",
                    csvField(input), csvField(dst.getPath()), opts.mode, f.size, f.weight,
                    f.otsu, f.threshold, img.getWidth(), img.getHeight(),
                    res.image.getWidth(), res.image.getHeight(), tLoad, tProc, tSave));
            String otsuS = f.threshold != f.otsu
                    ? " thr=" + f.threshold + " (otsu=" + f.otsu + ")" : " otsu=" + f.otsu;
            String timing = showTime
                    ? String.format(Locale.ROOT, "load %.0f | proc %.0f | save %.0f ms", tLoad, tProc, tSave)
                    : String.format(Locale.ROOT, "%.0f ms", tProc);
            System.out.printf(Locale.ROOT, "%s -> %s  [size=%d weight=%d%s | %s]%n",
                    input, dst, f.size, f.weight, otsuS, timing);
        }
        if (csvPath != null && count > 0) {
            java.nio.file.Files.writeString(java.nio.file.Paths.get(csvPath), csv.toString());
            System.out.println("metrics -> " + csvPath);
        }
        if (showTime && count > 1) {
            System.out.printf(Locale.ROOT,
                    "-- %d images | load %.2f s | proc %.2f s (%.0f ms/image) | save %.2f s%n",
                    count, totLoad / 1000, totProc / 1000, totProc / count, totSave / 1000);
        }
    }

    /** Quote a CSV field if it contains a comma or a quote. */
    static String csvField(String s) {
        return (s.contains(",") || s.contains("\"")) ? "\"" + s.replace("\"", "\"\"") + "\"" : s;
    }

    /** Minimal glob expansion (*, ?, and ** for recursion) for shells that do
     *  not expand wildcards. Returns {path, rel} pairs where rel is the path
     *  relative to the pattern's fixed prefix, so batch output mirrors the
     *  input folder tree. */
    static java.util.List<String[]> expand(String pattern) throws java.io.IOException {
        if (!pattern.contains("*") && !pattern.contains("?")) {
            return java.util.List.<String[]>of(new String[]{ pattern, new File(pattern).getName() });
        }
        java.util.List<String[]> out = new java.util.ArrayList<>();
        if (pattern.contains("**")) {
            int wc = pattern.indexOf('*');
            int q = pattern.indexOf('?');
            if (q >= 0 && q < wc) wc = q;
            int slash = Math.max(pattern.lastIndexOf('/', wc), pattern.lastIndexOf('\\', wc));
            java.nio.file.Path root = java.nio.file.Paths.get(slash >= 0 ? pattern.substring(0, slash) : ".");
            // Java's glob requires ** to span at least one directory; Python's
            // recursive glob lets it span zero, so also try the collapsed form
            var deep = java.nio.file.FileSystems.getDefault().getPathMatcher("glob:" + pattern);
            var flat = java.nio.file.FileSystems.getDefault()
                    .getPathMatcher("glob:" + pattern.replace("/**/", "/").replace("\\**\\", "\\"));
            try (var st = java.nio.file.Files.walk(root)) {
                st.filter(java.nio.file.Files::isRegularFile)
                  .map(java.nio.file.Path::normalize)
                  .filter(f -> deep.matches(f) || flat.matches(f))
                  .forEach(f -> out.add(new String[]{ f.toString(), root.relativize(f).toString() }));
            }
        } else {
            java.nio.file.Path p = java.nio.file.Paths.get(pattern);
            java.nio.file.Path dir = p.getParent() == null ? java.nio.file.Paths.get(".") : p.getParent();
            try (var ds = java.nio.file.Files.newDirectoryStream(dir, p.getFileName().toString())) {
                for (java.nio.file.Path f : ds) out.add(new String[]{ f.toString(), f.getFileName().toString() });
            }
        }
        out.sort(java.util.Comparator.comparing(e -> e[0]));
        return out;
    }
}
