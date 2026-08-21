import { useEffect, useState } from "react";
import { auth, firebaseConfigured } from "../firebase.js";

export function useAuth() {
  const [state, setState] = useState({
    status: firebaseConfigured ? "loading" : "unconfigured",
    user: null
  });

  useEffect(() => {
    if (!firebaseConfigured) {
      return undefined;
    }
    return auth.onAuthStateChanged((user) => {
      setState({ status: user ? "signed-in" : "signed-out", user });
    });
  }, []);

  return state;
}
