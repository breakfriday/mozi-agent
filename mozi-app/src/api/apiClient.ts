import axios, { type AxiosError, type AxiosRequestConfig } from "axios";
import { useAuthStore } from "@/store/useAuthStore";

export interface ApiResponse<T> { success: boolean; message: string; data: T }
export class ApiClientError extends Error {
  constructor(public readonly status?: number, public readonly data?: unknown, message = "Request failed") {
    super(message);
    this.name = "ApiClientError";
  }
}

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api";
const client = axios.create({ baseURL: API_BASE_URL, timeout: 15_000, headers: { "Content-Type": "application/json" } });

client.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});
client.interceptors.response.use(undefined, (error: AxiosError<ApiResponse<unknown>>) => {
  if (error.response?.status === 401) useAuthStore.getState().clearAuth();
  return Promise.reject(new ApiClientError(error.response?.status, error.response?.data?.data, error.response?.data?.message || error.message));
});

async function request<T>(config: AxiosRequestConfig) {
  const response = await client.request<ApiResponse<T>>(config);
  if (!response.data.success) throw new ApiClientError(undefined, response.data.data, response.data.message);
  return response.data.data;
}

export const apiClient = {
  request,
  get: <T>(url: string, config?: AxiosRequestConfig) => request<T>({ ...config, method: "GET", url }),
  post: <T, D = unknown>(url: string, data?: D, config?: AxiosRequestConfig<D>) => request<T>({ ...config, method: "POST", url, data }),
  put: <T, D = unknown>(url: string, data?: D, config?: AxiosRequestConfig<D>) => request<T>({ ...config, method: "PUT", url, data }),
  delete: <T>(url: string, config?: AxiosRequestConfig) => request<T>({ ...config, method: "DELETE", url }),
};
