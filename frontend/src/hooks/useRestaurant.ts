import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { restaurantApi } from '../lib/api';
import { formatMoney } from '../lib/format';

/** Restaurant from the route plus its profile (currency, timezone) and a money formatter. */
export function useRestaurant() {
  const { restaurantId = '' } = useParams<{ restaurantId: string }>();
  const query = useQuery({
    queryKey: ['restaurant-profile', restaurantId],
    queryFn: () => restaurantApi.getProfile(restaurantId),
    enabled: Boolean(restaurantId),
    staleTime: 5 * 60 * 1000,
  });

  const currency = query.data?.currencyCode ?? '';
  const decimals = query.data?.currencyDecimalPlaces ?? 2;

  return {
    restaurantId,
    restaurant: query.data,
    isLoading: query.isLoading,
    currency,
    decimals,
    money: (value: number | string | null | undefined) => formatMoney(value, currency || 'USD', decimals),
  };
}
