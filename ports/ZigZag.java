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
 * single global Otsu threshold; ink specks below an area that scales with the
 * window are then removed (despeckle).
 *
 * Single file, no dependencies, separable rolling sums (O(n)) on integers,
 * parallel across rows. Runs directly with Java (no compilation step):
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

    public static final String VERSION = "1.3.2";
    public static final int OTSU_CAP = 250;
    /** Options.size / Options.despeckle value that selects the automatic rule. */
    public static final int AUTO = -1;
    /** Largest window: keeps 255 * (size + 1)^2 inside the integer box sums
     *  (the automatic size stops at 250). */
    public static final int MAX_SIZE = 2048;
    static final java.util.List<String> MODES = java.util.List.of("binary", "gray", "color");

    /** Pipeline options. */
    public static class Options {
        public String mode = "binary";     // binary | gray | color
        public int size = AUTO;            // window in px, or AUTO (from the image diagonal)
        public int weight = 90;
        public boolean upsample = true;
        public int thresholdOffset = 0;    // manual shift of the auto Otsu threshold
        public int despeckle = AUTO;       // smallest ink component kept (px), 0 = keep all
    }

    /** Parameters used, auto Otsu and applied threshold. */
    public static class Info {
        public int size, weight, otsu, threshold, despeckle;
        public boolean autoSize;
    }

    /** Automatic window size: one window per 45 px of image diagonal, clamped
     *  to [20, 250]. sqrt (correctly rounded, unlike hypot) and an explicit
     *  floor(x + 0.5) keep the three ports in agreement on every input. */
    public static int autoSize(int w, int h) {
        double diag = Math.sqrt((double) w * w + (double) h * h);
        return (int) Math.min(250, Math.max(20, Math.floor(diag / 45 + 0.5)));
    }

    /** Automatic despeckle area: ink specks smaller than round(size^2 / 225)
     *  pixels are removed (an area, so it scales as the square of the window:
     *  2 px at size 20, 4 at 30, 26 at 77). Integer arithmetic, identical in
     *  every port. */
    public static int autoDespeckle(int size) {
        return (int) ((2L * size * size + 225) / 450);
    }

    public static class Result {
        public BufferedImage image;
        public Info info;
    }

    // -- helpers --------------------------------------------------------------

    /** Rec. 601 luma, round-half-up, one byte per pixel (read back with
     *  {@code & 0xFF}). Straight from the raster bytes in the common packed-BGR
     *  case (every JPEG), otherwise from readRgb. */
    static byte[] grayImage(BufferedImage img) {
        byte[] bgr = bgrBytesOrNull(img);
        if (bgr == null) return grayImage(readRgb(img));
        byte[] gray = new byte[img.getWidth() * img.getHeight()];
        IntStream.range(0, gray.length).parallel().forEach(i -> {
            int o = i * 3;
            gray[i] = luma(bgr[o + 2] & 0xFF, bgr[o + 1] & 0xFF, bgr[o] & 0xFF);
        });
        return gray;
    }

    /** Same, from 0xRRGGBB pixels. */
    static byte[] grayImage(int[] rgb) {
        byte[] gray = new byte[rgb.length];
        IntStream.range(0, rgb.length).parallel().forEach(i -> {
            int p = rgb[i];
            gray[i] = luma((p >> 16) & 0xFF, (p >> 8) & 0xFF, p & 0xFF);
        });
        return gray;
    }

    static byte luma(int r, int g, int b) {
        return (byte) Math.floor(r * 0.299 + g * 0.587 + b * 0.114 + 0.5);
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

    /** 2D box sum over [x-r..x+r]^2, zero-padded (truncated window), O(n).
     *  The inputs are bytes (gray levels, 0/1 flags) and the sums integers:
     *  exact in any order, a quarter of the memory traffic of doubles, and they
     *  convert to exactly the doubles a floating-point sum would give. Bounded
     *  by 255 * (2r + 1)^2, which MAX_SIZE keeps inside an int. */
    static int[] boxSum(byte[] src, int w, int h, int r, int[] tmp, int[] dst) {
        // horizontal pass, into tmp: the x loop is split where the window enters
        // and leaves the row, so the inner loops carry no bounds tests
        int initR = Math.min(r, w - 1);
        int addEnd = Math.max(1, w - r);      // x < addEnd  <=>  x + r < w
        int remBeg = r + 1;                   // x >= remBeg <=>  x - r - 1 >= 0
        IntStream.range(0, h).parallel().forEach(y -> {
            int base = y * w;
            int sum = 0;
            for (int x = 0; x <= initR; x++) sum += src[base + x] & 0xFF;
            tmp[base] = sum;
            int x = 1;
            for (int end = Math.min(addEnd, remBeg); x < end; x++) {        // add only
                sum += src[base + x + r] & 0xFF;
                tmp[base + x] = sum;
            }
            for (; x < addEnd; x++) {                                       // add and remove
                sum += (src[base + x + r] & 0xFF) - (src[base + x - r - 1] & 0xFF);
                tmp[base + x] = sum;
            }
            for (; x < remBeg && x < w; x++) tmp[base + x] = sum;           // neither
            for (; x < w; x++) {                                            // remove only
                sum -= src[base + x - r - 1] & 0xFF;
                tmp[base + x] = sum;
            }
        });
        // vertical pass, into dst: row y is row y-1 plus the row entering the
        // window minus the row leaving it, over strips of columns (one strip per
        // task) - memory read row by row, and loops simple enough for C2 to
        // vectorize on its own
        int strip = 256, strips = (w + strip - 1) / strip;
        int initB = Math.min(r, h - 1);
        IntStream.range(0, strips).parallel().forEach(s -> {
            int x0 = s * strip, x1 = Math.min(w, x0 + strip);
            System.arraycopy(tmp, x0, dst, x0, x1 - x0);
            for (int y = 1; y <= initB; y++) {
                for (int x = x0, b = y * w; x < x1; x++) dst[x] += tmp[b + x];
            }
            for (int y = 1; y < h; y++) {
                int o = y * w, p = o - w, add = (y + r) * w, rem = (y - r - 1) * w;
                if (y + r < h && y - r - 1 >= 0) {
                    for (int x = x0; x < x1; x++) dst[o + x] = dst[p + x] + tmp[add + x] - tmp[rem + x];
                } else if (y + r < h) {
                    for (int x = x0; x < x1; x++) dst[o + x] = dst[p + x] + tmp[add + x];
                } else if (y - r - 1 >= 0) {
                    for (int x = x0; x < x1; x++) dst[o + x] = dst[p + x] - tmp[rem + x];
                } else {
                    System.arraycopy(dst, p + x0, dst, o + x0, x1 - x0);
                }
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

    /** Center-aligned 2x bilinear upsampling fused with thresholding. At
     *  exactly 2x every output sample sits at -0.25 / +0.25 of a source pixel,
     *  so each source row yields two output rows from constant 0.25 / 0.75
     *  weights - the same samples as coverage(), written as pixels instead of
     *  being counted. */
    static byte[] upsampleBinarize(double[] src, int w, int h, int thr) {
        int W = w * 2;
        byte[] out = new byte[W * h * 2];
        IntStream.range(0, h).parallel().forEach(y -> {
            double[] rowA = new double[w], rowB = new double[w];
            verticalRows(src, w, h, y, rowA, rowB);
            int oa = 2 * y * W, ob = oa + W;
            for (double[] row : new double[][]{ rowA, rowB }) {
                int o = row == rowA ? oa : ob;
                binarizeRow(row, w, thr, out, o);
            }
        });
        return out;
    }

    /** The two horizontal 2x samples of each row pixel, thresholded into
     *  out[o + 2x] and out[o + 2x + 1]; x = 0 and x = w-1 clamp their neighbour. */
    static void binarizeRow(double[] row, int w, int thr, byte[] out, int o) {
        for (int x = 0; x < w; x++) {
            int xa = Math.max(0, x - 1), xb = Math.min(w - 1, x + 1);
            out[o + 2 * x]     = (row[xa] * 0.25 + row[x] * 0.75) >= thr ? (byte) 255 : 0;
            out[o + 2 * x + 1] = (row[x] * 0.75 + row[xb] * 0.25) >= thr ? (byte) 255 : 0;
        }
    }

    /** Antialiased cleanup coverage: threshold the 2x-upsampled foreground and
     *  average each 2x2 block back to 1x -> white coverage in {0,.25,.5,.75,1}.
     *  Same center-aligned bilinear samples as upsampleBinarize, never
     *  materializing the 2x image. */
    static double[] coverage(double[] src, int w, int h, int thr) {
        double[] cov = new double[w * h];
        IntStream.range(0, h).parallel().forEach(y -> {
            double[] rowA = new double[w], rowB = new double[w];
            verticalRows(src, w, h, y, rowA, rowB);
            coverageRow(rowA, rowB, w, thr, cov, y * w);
        });
        return cov;
    }

    /** White coverage of each row pixel (its four 2x samples, counted). */
    static void coverageRow(double[] rowA, double[] rowB, int w, int thr, double[] cov, int o) {
        for (int x = 0; x < w; x++) {
            int xa = Math.max(0, x - 1), xb = Math.min(w - 1, x + 1);
            int tl = (rowA[xa] * 0.25 + rowA[x] * 0.75) >= thr ? 1 : 0;
            int tr = (rowA[x] * 0.75 + rowA[xb] * 0.25) >= thr ? 1 : 0;
            int bl = (rowB[xa] * 0.25 + rowB[x] * 0.75) >= thr ? 1 : 0;
            int br = (rowB[x] * 0.75 + rowB[xb] * 0.25) >= thr ? 1 : 0;
            cov[o + x] = (tl + tr + bl + br) * 0.25;
        }
    }

    /** The vertical pass of the 2x upsampling for source row y: rowA holds
     *  output row 2y (sy = y - 0.25), rowB output row 2y+1 (sy = y + 0.25). */
    static void verticalRows(double[] src, int w, int h, int y, double[] rowA, double[] rowB) {
        int ya = Math.max(0, y - 1) * w, yc = y * w, yb = Math.min(h - 1, y + 1) * w;
        for (int x = 0; x < w; x++) {
            rowA[x] = src[ya + x] * 0.25 + src[yc + x] * 0.75;
            rowB[x] = src[yc + x] * 0.75 + src[yb + x] * 0.25;
        }
    }

    // -- core pipeline (Algorithm 1 of the paper) -----------------------------

    public static Result process(BufferedImage img, Options opts) {
        if (!MODES.contains(opts.mode)) {
            throw new IllegalArgumentException(
                    "invalid mode: " + opts.mode + " (expected binary, gray or color)");
        }
        int w = img.getWidth(), h = img.getHeight(), n = w * h;
        boolean auto = opts.size == AUTO;
        int size = auto ? autoSize(w, h) : opts.size;
        if (size < 2 || size > MAX_SIZE) {
            throw new IllegalArgumentException(
                    "invalid size: " + opts.size + " (expected 2.." + MAX_SIZE + ", or AUTO)");
        }
        if (opts.weight <= 0) {
            throw new IllegalArgumentException("invalid weight: " + opts.weight + " (expected > 0)");
        }
        int minArea = opts.despeckle == AUTO ? autoDespeckle(size) : opts.despeckle;
        if (minArea < 0) {
            throw new IllegalArgumentException("invalid despeckle: " + opts.despeckle + " (expected >= 0, or AUTO)");
        }
        int r = size / 2;
        double wf = opts.weight / 100.0;
        byte[] gray = grayImage(img);
        int[] tmp = new int[n];             // the box sums' scratch, shared

        // Pass A - background classification against the weighted local mean
        int[] sumAll = boxSum(gray, w, h, r, tmp, new int[n]);
        byte[] maskVal = new byte[n];       // gray value where background, else 0
        byte[] maskCnt = new byte[n];       // 1 where background, else 0
        IntStream.range(0, h).parallel().forEach(y -> {
            int cy = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1;
            background(gray, sumAll, wf, w, r, cy, maskVal, maskCnt, y * w);
        });

        // Pass B - normalization against the local mean of background-only pixels
        int[] cntBg = boxSum(maskCnt, w, h, r, tmp, new int[n]);

        Info info = new Info();
        info.size = size;
        info.autoSize = auto;
        info.weight = opts.weight;
        Result res = new Result();
        res.info = info;

        double[] fg = normalize(gray, boxSum(maskVal, w, h, r, tmp, sumAll), cntBg, w, h);

        // Otsu threshold on the foreground histogram (10% margin crop),
        // optionally shifted by the manual offset
        int otsuThr = otsu(histogram(fg, w, h, 10));
        int thr = Math.min(255, Math.max(0, otsuThr + opts.thresholdOffset));
        info.otsu = otsuThr;
        info.threshold = thr;
        info.despeckle = minArea;

        // Despeckle: ink components smaller than the area become paper. Done on
        // the 1x foreground, before any output: a removed speck's neighbours are
        // all paper, so every 2x sample around it is paper too, in every mode.
        if (minArea > 1) despeckle(fg, w, h, thr, minArea);

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
            int[] rgb = readRgb(img);
            int[] px = new int[n];
            IntStream.range(0, n).parallel().forEach(i -> {
                double ratio = fg[i] / Math.max(1, gray[i] & 0xFF);
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
            out.getRaster().setDataElements(0, 0, w, h, px);   // packed RGB, no colour conversion
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

    /** Turn 8-connected ink components (fg < thr) smaller than minArea into
     *  paper (255). Union-find over runs: each horizontal run of ink is one
     *  node, joined to the runs of the row above that touch it (8-connectivity:
     *  overlapping once widened by a pixel); a root holds its component's size
     *  as a negative number. Components are unique, so the result is the same
     *  as any other labelling - a run per node just makes far fewer unions. */
    static void despeckle(double[] fg, int w, int h, int thr, int minArea) {
        int[] parent = new int[w * h];   // at a run's first pixel: parent run, or -size
        int[][] above = { new int[w], new int[w] }, row = { new int[w], new int[w] };
        int na = 0;
        for (int y = 0; y < h; y++) {
            int base = y * w, nr = 0;
            for (int x = 0, k = 0; x < w;) {
                if (fg[base + x] >= thr) { x++; continue; }
                int s = x;
                while (x < w && fg[base + x] < thr) x++;
                parent[base + s] = s - x;                   // a run of x - s pixels
                row[0][nr] = s;
                row[1][nr++] = x;
                while (k < na && above[1][k] < s) k++;      // ends left of column s - 1
                for (int j = k; j < na && above[0][j] <= x; j++) union(parent, base + s, base - w + above[0][j]);
            }
            int[][] t = above; above = row; row = t;
            na = nr;
        }
        for (int y = 0; y < h; y++) {
            int base = y * w;
            for (int x = 0; x < w;) {
                if (fg[base + x] >= thr) { x++; continue; }
                int s = x;
                while (x < w && fg[base + x] < thr) x++;
                if (-parent[find(parent, base + s)] < minArea) java.util.Arrays.fill(fg, base + s, base + x, 255);
            }
        }
    }

    static int find(int[] parent, int i) {
        while (parent[i] >= 0) {
            int p = parent[i];
            if (parent[p] >= 0) parent[i] = parent[p];   // path halving
            i = p;
        }
        return i;
    }

    static void union(int[] parent, int a, int b) {
        int ra = find(parent, a), rb = find(parent, b);
        if (ra == rb) return;
        if (parent[ra] > parent[rb]) { int t = ra; ra = rb; rb = t; }   // ra = larger
        parent[ra] += parent[rb];
        parent[rb] = ra;
    }

    /** Pass A for the row at base: background where the gray level reaches the
     *  weighted mean of its (clamped) window. */
    static void background(byte[] gray, int[] sumAll, double wf, int w, int r, int cy,
                           byte[] maskVal, byte[] maskCnt, int base) {
        for (int x = 0; x < w; x++) {
            int i = base + x;
            int cx = Math.min(w - 1, x + r) - Math.max(0, x - r) + 1;
            if ((gray[i] & 0xFF) >= wf * sumAll[i] / (cx * cy)) {
                maskVal[i] = gray[i];
                maskCnt[i] = 1;
            }
        }
    }

    /** Pass B: fg = 255 if v >= mean_bg else v*256/mean_bg; all-foreground
     *  windows -> 255. */
    static double[] normalize(byte[] gray, int[] sumBg, int[] cntBg, int w, int h) {
        double[] fg = new double[w * h];
        IntStream.range(0, h).parallel().forEach(y -> {
            foreground(gray, sumBg, cntBg, fg, y * w, (y + 1) * w);
        });
        return fg;
    }

    /** Pass B for pixels from..to-1. */
    static void foreground(byte[] gray, int[] sumBg, int[] cntBg, double[] fg, int from, int to) {
        for (int i = from; i < to; i++) {
            int cnt = cntBg[i];
            double meanBg = cnt > 0 ? (double) sumBg[i] / cnt : 0;
            double v = gray[i] & 0xFF;
            fg[i] = (v >= meanBg || cnt == 0) ? 255 : Math.min(255, v * 256 / Math.max(1, meanBg));
        }
    }

    // -- CLI ------------------------------------------------------------------

    static final String USAGE = "Usage: java ZigZag.java <inputs...> [--output=path|dir] "
            + "[--mode=binary|gray|color] [--size=N|auto] [--weight=N] [--threshold-offset=N] "
            + "[--despeckle=N|auto] "
            + "[--no-upsample] [--time] [--csv=path] [--version]";

    /** Exit status: 0 success, 1 an input failed, 2 bad command line. */
    public static void main(String[] args) throws Exception {
        int status = run(args);
        if (status != 0) System.exit(status);
    }

    /** Integer option value, or null after printing why it is not one. */
    static Integer intArg(String name, String v, int min) {
        try {
            int n = Integer.parseInt(v);
            if (n >= min) return n;
        } catch (NumberFormatException e) { /* reported below */ }
        System.err.println("Invalid " + name + "=" + v + " (expected an integer >= " + min + ")");
        return null;
    }

    static int run(String[] args) throws Exception {
        java.util.List<String[]> inputs = new java.util.ArrayList<>();
        String output = null, csvPath = null;
        boolean showTime = false;
        Options opts = new Options();
        for (String a : args) {
            Integer v = 0;
            if (a.startsWith("--mode=")) opts.mode = a.substring(7);
            else if (a.equals("--size=auto")) opts.size = AUTO;
            else if (a.startsWith("--size=")) { if ((v = intArg("--size", a.substring(7), 2)) != null) opts.size = v; }
            else if (a.startsWith("--weight=")) { if ((v = intArg("--weight", a.substring(9), 1)) != null) opts.weight = v; }
            else if (a.equals("--despeckle=auto")) opts.despeckle = AUTO;
            else if (a.startsWith("--despeckle=")) { if ((v = intArg("--despeckle", a.substring(12), 0)) != null) opts.despeckle = v; }
            else if (a.startsWith("--threshold-offset=")) {
                if ((v = intArg("--threshold-offset", a.substring(19), Integer.MIN_VALUE)) != null) opts.thresholdOffset = v;
            }
            else if (a.startsWith("--output=")) output = a.substring(9);
            else if (a.equals("--no-upsample")) opts.upsample = false;
            else if (a.equals("--time")) showTime = true;
            else if (a.startsWith("--csv=")) csvPath = a.substring(6);
            else if (a.equals("--version")) {
                System.out.println("ZigZag " + VERSION);
                return 0;
            }
            else if (a.equals("--help") || a.equals("-h")) {
                System.out.println(USAGE);
                return 0;
            }
            else if (a.startsWith("--")) {
                System.err.println("Unknown option: " + a);
                return 2;
            }
            else inputs.addAll(expand(a));
            if (v == null) return 2;
        }
        if (!MODES.contains(opts.mode)) {
            System.err.println("Invalid --mode=" + opts.mode + " (expected binary, gray or color)");
            return 2;
        }
        if (inputs.isEmpty()) {
            boolean hadPatterns = java.util.Arrays.stream(args).anyMatch(a -> !a.startsWith("--"));
            System.err.println(hadPatterns ? "No input images found." : USAGE);
            return hadPatterns ? 1 : 2;
        }

        File outDir = null;
        if (output != null && (inputs.size() > 1 || new File(output).isDirectory()
                || output.endsWith(File.separator) || output.endsWith("/"))) {
            outDir = new File(output);
            outDir.mkdirs();
        }

        StringBuilder csv = new StringBuilder(
                "input,output,mode,size,weight,otsu,threshold,despeckle,backend,in_width,in_height,"
                + "out_width,out_height,load_ms,proc_ms,save_ms\n");
        double totLoad = 0, totProc = 0, totSave = 0;
        int count = 0, failed = 0;
        for (String[] entry : inputs) {
            String input = entry[0], rel = entry[1];
            File in = new File(input);
            if (!in.exists()) {
                System.err.println("File not found: " + input);
                failed++;
                continue;
            }
            long t0 = System.nanoTime();
            BufferedImage img = ImageIO.read(in);
            if (img == null) {
                System.err.println("Cannot read image: " + input);
                failed++;
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
            csv.append(String.format(Locale.ROOT, "%s,%s,%s,%d,%d,%d,%d,%d,cpu,%d,%d,%d,%d,%.1f,%.1f,%.1f\n",
                    csvField(input), csvField(dst.getPath()), opts.mode, f.size, f.weight,
                    f.otsu, f.threshold, f.despeckle, img.getWidth(), img.getHeight(),
                    res.image.getWidth(), res.image.getHeight(), tLoad, tProc, tSave));
            String sizeS = f.autoSize ? f.size + " (auto)" : String.valueOf(f.size);
            String otsuS = f.threshold != f.otsu
                    ? " thr=" + f.threshold + " (otsu=" + f.otsu + ")" : " otsu=" + f.otsu;
            String timing = showTime
                    ? String.format(Locale.ROOT, "load %.0f | proc %.0f | save %.0f ms", tLoad, tProc, tSave)
                    : String.format(Locale.ROOT, "%.0f ms", tProc);
            System.out.printf(Locale.ROOT, "%s -> %s  [size=%s weight=%d despeckle=%d%s | %s]%n",
                    input, dst, sizeS, f.weight, f.despeckle, otsuS, timing);
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
        return failed > 0 ? 1 : 0;
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
        int wc = pattern.indexOf('*');
        int q = pattern.indexOf('?');
        if (wc < 0 || (q >= 0 && q < wc)) wc = q;
        int slash = Math.max(pattern.lastIndexOf('/', wc), pattern.lastIndexOf('\\', wc));
        boolean wildDir = pattern.indexOf('/', wc) >= 0 || pattern.indexOf('\\', wc) >= 0;
        if (wildDir) {     // ** or a wildcard in a directory name ("scans/*/p*.jpg")
            java.nio.file.Path root = java.nio.file.Paths.get(slash >= 0 ? pattern.substring(0, slash) : ".");
            // without **, the walk never needs to go deeper than the pattern
            int depth = Integer.MAX_VALUE;
            if (!pattern.contains("**")) {
                depth = 0;
                for (char c : pattern.substring(slash + 1).toCharArray()) if (c == '/' || c == '\\') depth++;
                depth++;
            }
            // Java's glob requires ** to span at least one directory; Python's
            // recursive glob lets it span zero, so also try the collapsed form
            var deep = java.nio.file.FileSystems.getDefault().getPathMatcher("glob:" + pattern);
            var flat = java.nio.file.FileSystems.getDefault()
                    .getPathMatcher("glob:" + pattern.replace("/**/", "/").replace("\\**\\", "\\")
                            .replaceFirst("^\\*\\*[/\\\\]", ""));   // leading **/ too
            if (!java.nio.file.Files.isDirectory(root)) return out;
            java.nio.file.Path base = root.normalize();     // "." -> "", so rel has no "../"
            try (var st = java.nio.file.Files.walk(root, depth)) {
                st.filter(java.nio.file.Files::isRegularFile)
                  .map(java.nio.file.Path::normalize)
                  .filter(f -> deep.matches(f) || flat.matches(f))
                  .forEach(f -> out.add(new String[]{ f.toString(), base.relativize(f).toString() }));
            }
        } else {
            java.nio.file.Path p = java.nio.file.Paths.get(pattern);
            java.nio.file.Path dir = p.getParent() == null ? java.nio.file.Paths.get(".") : p.getParent();
            if (!java.nio.file.Files.isDirectory(dir)) return out;
            try (var ds = java.nio.file.Files.newDirectoryStream(dir, p.getFileName().toString())) {
                for (java.nio.file.Path f : ds) out.add(new String[]{ f.toString(), f.getFileName().toString() });
            }
        }
        out.sort(java.util.Comparator.comparing(e -> e[0]));
        return out;
    }
}
