import Image from 'next/image';
import { cn } from '@/lib/utils';

/**
 * Brand surface for CRM PTMO OPERATION DEPT (Minda Optima).
 *
 * Assets
 * ------
 * The vector master is `brand/MindaOptima-logo.ai`, kept out of
 * `public/` so it is never served. Both PNGs under `public/brand/` are
 * rendered from that master at 288 DPI and are the FULL logo — the
 * character, the disc and the wordmark together:
 *
 *   minda-optima-logo.png  1280 x 845  full lockup, transparent margin
 *                                      trimmed to the artwork's edge
 *   minda-optima-mark.png   512 x 512  the same full lockup CONTAINED
 *                                      inside a square with transparent
 *                                      padding — padded, never cropped
 *
 * Anti-cropping rules that every component below follows
 * -----------------------------------------------------
 *   1. Each asset's real pixel dimensions are declared once, here, as
 *      the aspect ratio. Callers pass a width; the height is derived,
 *      so the box can never disagree with the artwork.
 *   2. `object-contain` on every <Image>, so if a parent ever does
 *      constrain a dimension the artwork letterboxes instead of being
 *      sliced.
 *   3. Each logo sits inside its own wrapper element. The `Card`
 *      primitive is `overflow-hidden` and `CardHeader` is a CSS grid
 *      with explicit rows — dropping a bare <img> straight into that
 *      grid let the cell, not the image, decide the box, which is what
 *      clipped the login logo. The wrapper takes the grid cell and the
 *      image sizes itself inside it.
 *   4. No component crops, masks or rounds the official artwork.
 */

/** Visible product name. Single source of truth for chrome + metadata. */
export const PRODUCT_NAME = 'CRM PTMO OPERATION DEPT';

/** Shortened lock-up for very tight chrome (mobile sidebar rail). */
export const PRODUCT_NAME_SHORT = 'CRM PTMO';
export const PRODUCT_NAME_SUFFIX = 'Operation Dept';

/** Owning organisation. */
export const ORG_NAME = 'Minda Optima';

/** Intrinsic pixel size of the exported assets — the ratio source. */
const LOCKUP = { w: 1280, h: 845 } as const;
const SQUARE = { w: 512, h: 512 } as const;

/**
 * Full logo contained in a square box. Used where the chrome needs a
 * square footprint (sidebar rail). The asset is padded, not cropped.
 */
export function BrandMark({
  size = 36,
  className,
  label,
}: {
  size?: number;
  className?: string;
  label?: string;
}) {
  return (
    <span
      className={cn('block shrink-0', className)}
      style={{ width: size, height: size }}
    >
      <Image
        src="/brand/minda-optima-mark.png"
        alt={label ?? ''}
        aria-hidden={label ? undefined : true}
        width={SQUARE.w}
        height={SQUARE.h}
        priority
        sizes="72px"
        className="h-full w-full object-contain"
      />
    </span>
  );
}

/**
 * Full logo lockup, rendered at its natural proportions. `width` is a
 * ceiling, not a fixed size: the wrapper shrinks on narrow screens and
 * the height follows the aspect ratio, so the artwork stays whole.
 */
export function BrandLockup({
  width = 208,
  className,
}: {
  width?: number;
  className?: string;
}) {
  return (
    <span
      className={cn('mx-auto block w-full', className)}
      style={{ maxWidth: width }}
    >
      <Image
        src="/brand/minda-optima-logo.png"
        alt={`${ORG_NAME} — ${PRODUCT_NAME}`}
        width={LOCKUP.w}
        height={LOCKUP.h}
        priority
        sizes="(max-width: 480px) 60vw, 208px"
        className="h-auto w-full object-contain"
      />
    </span>
  );
}

/**
 * Sidebar identity: square logo + two-line product name. The name is
 * split so the long form never forces a horizontal overflow inside the
 * 15rem rail — line one carries the product, line two the department.
 */
export function BrandWordmark({ className }: { className?: string }) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <BrandMark size={34} />
      <span className="flex min-w-0 flex-col">
        <span className="text-foreground truncate text-[13px] leading-4 font-semibold tracking-tight">
          {PRODUCT_NAME_SHORT}
        </span>
        <span className="text-muted-foreground truncate text-[10px] leading-4 font-medium tracking-[0.14em] uppercase">
          {PRODUCT_NAME_SUFFIX}
        </span>
      </span>
    </span>
  );
}

/**
 * Auth-screen header: logo above an uppercase product line. Sized down
 * on small viewports so the card never has to scroll to show the brand.
 */
export function BrandAuthHeader({ className }: { className?: string }) {
  return (
    <span className={cn('mb-4 flex w-full flex-col items-center', className)}>
      <BrandLockup width={196} className="max-w-[58vw] sm:max-w-[196px]" />
      <span className="text-muted-foreground mt-3 text-[10px] leading-4 font-semibold tracking-[0.18em] uppercase sm:text-[11px]">
        {PRODUCT_NAME}
      </span>
    </span>
  );
}
