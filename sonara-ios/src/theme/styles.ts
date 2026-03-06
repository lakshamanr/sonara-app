import { StyleSheet } from 'react-native';
import { Colors } from './colors';

export const Typography = {
  // Font families
  serif: 'Georgia',
  sans: 'System',

  // Sizes
  xs: 11,
  sm: 13,
  base: 15,
  md: 17,
  lg: 20,
  xl: 24,
  xxl: 30,
  hero: 38,

  // Weights
  light: '300' as const,
  regular: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
};

export const GlobalStyles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  safeScreen: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  card: {
    backgroundColor: Colors.bgCard,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  surface: {
    backgroundColor: Colors.bgSurface,
    borderRadius: 10,
  },
  input: {
    backgroundColor: Colors.bgInput,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    color: Colors.textPrimary,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: Typography.base,
  },
  btn: {
    backgroundColor: Colors.gold,
    borderRadius: 8,
    paddingHorizontal: 18,
    paddingVertical: 11,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  btnText: {
    color: Colors.textInverse,
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
  },
  btnOutline: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 18,
    paddingVertical: 11,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  btnOutlineText: {
    color: Colors.textSecondary,
    fontSize: Typography.base,
    fontWeight: Typography.medium,
  },
  sectionTitle: {
    color: Colors.textPrimary,
    fontSize: Typography.lg,
    fontWeight: Typography.semibold,
    marginBottom: 4,
  },
  sectionSubtitle: {
    color: Colors.textMuted,
    fontSize: Typography.sm,
  },
  separator: {
    height: 1,
    backgroundColor: Colors.border,
    marginVertical: 8,
  },
});
