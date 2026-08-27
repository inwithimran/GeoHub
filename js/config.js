// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyANw4D4Y-Be7R3Jctg5uNKnRa2AtG8dHGs",
  authDomain: "geohub-geo-env.firebaseapp.com",
  projectId: "geohub-geo-env",
  storageBucket: "geohub-geo-env.firebasestorage.app",
  messagingSenderId: "219912104826",
  appId: "1:219912104826:web:bc47576804468d343b44c3",
  measurementId: "G-E8XXFVJHVQ"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);