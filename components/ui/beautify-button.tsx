"use client";

import { AlignLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { describeBeautifyTarget } from "@/lib/utils/beautify";
import { cn } from "@/lib/utils";

export type BeautifyButtonProps = {
  onBeautify: () => void;
  language: string;
  disabled?: boolean;
  pending?: boolean;
  className?: string;
};

/**
 * Named action for the config editors.
 *
 * It carries its label rather than standing as a bare glyph: on a short field
 * this is the only affordance, so a viewer who has never met it has nothing
 * else to read. The tooltip adds the part the label cannot say - which format
 * the value will be reprinted as, and that references survive it.
 */
export function BeautifyButton({
  onBeautify,
  language,
  disabled,
  pending,
  className,
}: BeautifyButtonProps): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
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
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        {describeBeautifyTarget(language)}
      </TooltipContent>
    </Tooltip>
  );
}
