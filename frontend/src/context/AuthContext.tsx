import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authApi } from '../lib/api';

export interface UserSession {
  adminAccountId: string;
  accountKind: 'SUPERADMIN' | 'RESTAURANT_ADMIN';
  restaurantId: string | null;
  fullName: string;
  email: string;
}

interface AuthContextType {
  user: UserSession | null;
  isLoading: boolean;
  activeRestaurantId: string | null;
  setActiveRestaurantId: (id: string | null) => void;
  login: (email: string, password?: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeRestaurantId, setActiveRestaurantIdState] = useState<string | null>(() => {
    return localStorage.getItem('workforce_active_restaurant') || null;
  });

  const setActiveRestaurantId = useCallback((id: string | null) => {
    setActiveRestaurantIdState(id);
    if (id) {
      localStorage.setItem('workforce_active_restaurant', id);
    } else {
      localStorage.removeItem('workforce_active_restaurant');
    }
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const me = await authApi.me();
      setUser(me);
      if (me.accountKind === 'RESTAURANT_ADMIN' && me.restaurantId) {
        setActiveRestaurantId(me.restaurantId);
      } else if (me.accountKind === 'SUPERADMIN' && !activeRestaurantId) {
        // default to 1 (The Grand Bistro) for smooth immediate exploration
        setActiveRestaurantId('1');
      }
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, [activeRestaurantId, setActiveRestaurantId]);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  const login = async (email: string, password?: string) => {
    setIsLoading(true);
    try {
      const res = await authApi.login({ email, password });
      setUser({
        adminAccountId: res.accountId,
        accountKind: res.accountKind as any,
        restaurantId: res.restaurantId,
        fullName: res.fullName,
        email: res.email,
      });
      if (res.accountKind === 'RESTAURANT_ADMIN' && res.restaurantId) {
        setActiveRestaurantId(res.restaurantId);
      } else if (res.accountKind === 'SUPERADMIN') {
        setActiveRestaurantId('1');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async () => {
    try {
      await authApi.logout();
    } finally {
      setUser(null);
      setActiveRestaurantId(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        activeRestaurantId,
        setActiveRestaurantId,
        login,
        logout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
