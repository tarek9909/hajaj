import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { currentMonth, monthLabel, shiftMonth } from '../lib/format';

interface PeriodContextType {
  /** Selected payroll month, YYYY-MM. Shared by every month-based screen. */
  month: string;
  label: string;
  isCurrent: boolean;
  setMonth: (month: string) => void;
  shift: (delta: number) => void;
  reset: () => void;
  /** True once the user (or the app) has picked a month, so the default is only applied once. */
  hasChosen: boolean;
}

const PeriodContext = createContext<PeriodContextType | undefined>(undefined);
const STORAGE_KEY = 'workforce_period';

function savedMonth(): string | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && /^\d{4}-\d{2}$/.test(saved)) return saved;
  } catch {
    /* ignore */
  }
  return null;
}

export const PeriodProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [month, setMonthState] = useState<string>(() => savedMonth() ?? currentMonth());
  const [hasChosen, setHasChosen] = useState<boolean>(() => savedMonth() !== null);

  const setMonth = useCallback((next: string) => {
    if (!/^\d{4}-\d{2}$/.test(next)) return;
    setMonthState(next);
    setHasChosen(true);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<PeriodContextType>(
    () => ({
      month,
      label: monthLabel(month),
      isCurrent: month === currentMonth(),
      setMonth,
      shift: (delta) => setMonth(shiftMonth(month, delta)),
      reset: () => setMonth(currentMonth()),
      hasChosen,
    }),
    [month, setMonth, hasChosen]
  );

  return <PeriodContext.Provider value={value}>{children}</PeriodContext.Provider>;
};

export const usePeriod = (): PeriodContextType => {
  const ctx = useContext(PeriodContext);
  if (!ctx) throw new Error('usePeriod must be used within a PeriodProvider');
  return ctx;
};
