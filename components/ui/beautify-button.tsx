"use client";

import { AlignLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type BeautifyButtonProps = {
  onBeautify: () => void;
  disabled?: boolean;
  pending?: boolean;
  className?: string;
};

/**
 * Named action for the config editors' toolbar strip.
 *
 * It carries its label rather than standing as a bare glyph: the strip is the
 * only affordance on the field, so a viewer who has never met it has nothing
 * else to read. It also never overlaps the editor's first line, which a
 * floating control does on the short fields this sits on most.
 */
export function BeautifyButton({
  onBeautify,
  disabled,
  pending,
  className,
}: BeautifyButtonProps): React.ReactElement {
  return (
    <Button
      className={cn(
        "h-6 gap-1.5 px-2 font-normal text-muted-foreground text-xs hover:text-foreground",
        className
      )}
      disabled={disabled || pending}
      onClick={onBeautify}
      size="sm"
      type="button"
      variant="ghost"
    >
      {pending ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <AlignLeft className="size-3" />
      )}
      Beautify
    </Button>
  );
}
