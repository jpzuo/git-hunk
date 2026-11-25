/**
 * 全局统一图标操作按钮组件 (IconButton)
 * - 工具栏/操作栏仅展示图标，悬浮立即弹出 VS Code Dark Modern 风格文字 Tooltip
 * - 通过 Portal 挂载于 document.body，避免被滚动区域或 overflow 容器裁剪
 */

import React, { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

export type IconButtonVariant = "ghost" | "surface" | "danger" | "active";
export type IconButtonSize = "xs" | "sm";

export interface IconButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title" | "children"> {
  tooltip: string;
  icon: React.ReactNode;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  align?: "center" | "right";
}

const SIZE_CLS: Record<IconButtonSize, string> = {
  xs: "w-[20px] h-[20px]",
  sm: "w-[24px] h-[22px]",
};

const VARIANT_CLS: Record<IconButtonVariant, string> = {
  ghost:
    "bg-transparent border border-transparent text-[#9d9d9d] hover:bg-[#2a2d2e] hover:text-white",
  surface:
    "bg-[#252526] border border-[#3c3c3c] text-[#cccccc] hover:bg-[#2a2d2e] hover:border-[#454545] hover:text-white",
  active:
    "bg-[#2a2d2e] border border-[#3c3c3c] text-white",
  danger:
    "bg-transparent border border-transparent text-[#9d9d9d] hover:bg-[#f14c4c]/15 hover:text-[#f14c4c]",
};

export const IconButton = React.memo(function IconButton({
  tooltip,
  icon,
  variant = "ghost",
  size = "sm",
  align = "center",
  className = "",
  disabled,
  onMouseEnter,
  onMouseLeave,
  onClick,
  type = "button",
  ...rest
}: IconButtonProps) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  const hide = useCallback(() => setRect(null), []);

  useEffect(() => {
    if (disabled) setRect(null);
  }, [disabled]);

  useEffect(() => {
    if (!rect) return;
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [rect, hide]);

  const showBelow = rect ? rect.bottom + 34 < window.innerHeight : true;
  const centerX = rect ? rect.left + rect.width / 2 : 0;
  const rightX = rect ? window.innerWidth - rect.right : 0;

  return (
    <>
      <button
        type={type}
        aria-label={tooltip}
        disabled={disabled}
        className={`inline-flex items-center justify-center rounded-[4px] p-0 cursor-pointer transition-colors shrink-0 disabled:opacity-35 disabled:cursor-default ${SIZE_CLS[size]} ${VARIANT_CLS[variant]} ${className}`}
        onMouseEnter={(e) => {
          if (!disabled) {
            setRect(e.currentTarget.getBoundingClientRect());
          }
          onMouseEnter?.(e);
        }}
        onMouseLeave={(e) => {
          setRect(null);
          onMouseLeave?.(e);
        }}
        onClick={(e) => {
          setRect(null);
          onClick?.(e);
        }}
        {...rest}
      >
        {icon}
      </button>

      {rect &&
        createPortal(
          <div
            role="tooltip"
            className="pointer-events-none fixed z-[200] whitespace-nowrap rounded-[3px] border border-[#454545] bg-[#252526] px-2 py-1 text-[11px] font-normal leading-none text-[#cccccc] shadow-[0_4px_12px_rgba(0,0,0,0.55)]"
            style={{
              top: showBelow ? rect.bottom + 6 : rect.top - 28,
              ...(align === "right" || centerX > window.innerWidth - 96
                ? { right: Math.max(8, rightX) }
                : {
                    left: Math.max(8, centerX),
                    transform: "translateX(-50%)",
                  }),
            }}
          >
            {tooltip}
          </div>,
          document.body,
        )}
    </>
  );
});
