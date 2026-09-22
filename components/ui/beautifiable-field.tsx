"use client";

import { useCallback, useRef } from "react";
import { BeautifyButton } from "@/components/ui/beautify-button";
import { useBeautify } from "@/lib/hooks/use-beautify";
import { canBeautifyLanguage } from "@/lib/utils/beautify";
import { cn } from "@/lib/utils";

export type BeautifiableFieldProps = {
  /** The field's stored text. Formatting preserves whichever form it is in. */
  value: string;
  onChange: (value: string) => void;
  language: string;
  disabled?: boolean;
  /**
   * Hides the action while keeping the frame, for a field that is present but
   * not currently editable - the ABI field in automatic mode, say.
   */
  showAction?: boolean;
  className?: string;
  children: React.ReactNode;
};

/**
 * The frame every beautifiable config field shares: a border around the input,
 * with the action in a strip along the top.
 *
 * It exists so the three families - the Monaco editors, the JSON textareas and
 * the ABI field - cannot drift apart. They did once: the textareas carried the
 * action on a row of its own between the label and the input, because the
 * badge editor draws its own border and wrapping it looked like more work than
 * it was.
 *
 * The strip is dropped for a language with no formatter behind it, so the
 * frame is still the same element on the SQL field.
 */
export function BeautifiableField({
  value,
  onChange,
  language,
  disabled,
  showAction = true,
  className,
  children,
}: BeautifiableFieldProps): React.ReactElement {
  // A ref, so the hook compares against the field's current text rather than
  // the value captured when the action was clicked.
  const valueRef = useRef(value);
  valueRef.current = value;
  const read = useCallback((): string => valueRef.current, []);

  const { pending, beautify } = useBeautify({
    apply: onChange,
    disabled,
    language,
    read,
  });

  const actionVisible = showAction && canBeautifyLanguage(language);

  return (
    <div className={cn("overflow-hidden rounded-md border", className)}>
      {actionVisible && (
        <div className="flex items-center justify-end border-b bg-muted/30 px-1.5 py-1">
          <BeautifyButton
            disabled={disabled}
            language={language}
            onBeautify={beautify}
            pending={pending}
          />
        </div>
      )}
      {children}
    </div>
  );
}
