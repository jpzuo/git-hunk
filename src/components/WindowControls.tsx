import React, { useEffect, useState } from "react";
import { api } from "../api";

const MinimizeIcon = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
    <path d="M0 5.5H10" stroke="currentColor" strokeWidth="1" />
  </svg>
);

const MaximizeIcon = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
    <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" />
  </svg>
);

const RestoreIcon = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
    <path d="M2.5 2.5V0.5H9.5V7.5H7.5" stroke="currentColor" strokeWidth="1" fill="none" />
    <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" />
  </svg>
);

const CloseIcon = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
    <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1" />
  </svg>
);

export const WindowControls = React.memo(function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    void api.windowIsMaximized().then(setIsMaximized).catch(() => {});

    const handleResize = () => {
      void api.windowIsMaximized().then(setIsMaximized).catch(() => {});
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const handleMinimize = () => {
    void api.windowMinimize().catch(() => {});
  };

  const handleToggleMaximize = async () => {
    try {
      const max = await api.windowToggleMaximize();
      setIsMaximized(max);
    } catch {
      // ignore
    }
  };

  const handleClose = () => {
    void api.windowClose().catch(() => {});
  };

  return (
    <div className="flex items-center h-full ml-1 select-none shrink-0 [-webkit-app-region:no-drag]">
      <button
        type="button"
        className="flex items-center justify-center w-[44px] h-full border-none rounded-none bg-transparent text-[#cccccc] hover:bg-[#2a2d2e] hover:text-white cursor-pointer transition-colors p-0"
        title="最小化"
        onClick={handleMinimize}
      >
        <MinimizeIcon />
      </button>
      <button
        type="button"
        className="flex items-center justify-center w-[44px] h-full border-none rounded-none bg-transparent text-[#cccccc] hover:bg-[#2a2d2e] hover:text-white cursor-pointer transition-colors p-0"
        title={isMaximized ? "向下还原" : "最大化"}
        onClick={handleToggleMaximize}
      >
        {isMaximized ? <RestoreIcon /> : <MaximizeIcon />}
      </button>
      <button
        type="button"
        className="flex items-center justify-center w-[44px] h-full border-none rounded-none bg-transparent text-[#cccccc] hover:bg-[#e81123] hover:text-white cursor-pointer transition-colors p-0"
        title="隐藏到系统托盘"
        onClick={handleClose}
      >
        <CloseIcon />
      </button>
    </div>
  );
});
