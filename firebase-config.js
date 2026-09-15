const firebaseConfig = {
  apiKey: "AIzaSyBUtkkgu_9rN0DwPi7lDDd3GjmY8VJ6xR8",
  authDomain: "smart-group-settlement.firebaseapp.com",
  projectId: "smart-group-settlement",
  storageBucket: "smart-group-settlement.firebasestorage.app",
  messagingSenderId: "255104818785",
  appId: "1:255104818785:web:5cfa97b432f3f0337b5420"
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();